import mongoose from 'mongoose';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import Expence from '../models/expence.model.js';
import {uploadOnCloudinary} from '../utils/cloudinary.js';
import { tryCatch } from 'bullmq';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const localUploadsDir = path.resolve(__dirname, '../../uploads/expenses');
const tmpUploadsDir = path.join('/tmp', 'uploads', 'expenses');

let uploadsDir = localUploadsDir;
try {
  fs.mkdirSync(localUploadsDir, {recursive: true});
} catch {
  fs.mkdirSync(tmpUploadsDir, {recursive: true});
  uploadsDir = tmpUploadsDir;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const uniqueName = `${Date.now()}-${file.originalname.replace(/\s+/g, '')}`;
    cb(null, uniqueName);
  },
});

const fileFilter = (_req, file, cb) => {
  const allowed = /jpeg|jpg|png|webp/;
  cb(null, allowed.test(file.mimetype));
};

export const uploadExpenceReceipt = multer({
  storage,
  fileFilter,
  limits: {fileSize: 5 * 1024 * 1024},
});

const parseMaybeJson = value => {
  if (value == null || value === '') return undefined;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const resolveReceiptUrl = async req => {
  if (!req.file?.path) return undefined;
  try {
    const uploadedUrl = await uploadOnCloudinary(req.file.path, {
      folder: 'woowoo/expenses',
    });
    return uploadedUrl || null;
  } catch (error) {
    console.error('expense receipt upload error:', error);
    return null;
  }
};

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

const resolveExpenseMode = (paymentBreakdown = {}, fallback = 'Cash') => {
  const ranked = [
    ['Cash', Number(paymentBreakdown.cash) || 0],
    ['UPI', Number(paymentBreakdown.upi) || 0],
    ['Card', Number(paymentBreakdown.card) || 0],
    ['Wallet', Number(paymentBreakdown.wallet) || 0],
  ].filter(([, amount]) => amount > 0);
  if (ranked.length === 0) return fallback;
  ranked.sort((a, b) => b[1] - a[1]);
  return ranked.length === 1 ? ranked[0][0] : ranked[0][0];
};

const normalizeDueFields = expence => {
  const total = round2(expence.amount);
  let paidAmount =
    expence.paidAmount != null ? round2(expence.paidAmount) : round2((expence.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0));
  let dueAmount =
    expence.dueAmount != null ? round2(expence.dueAmount) : round2(Math.max(0, total - paidAmount));

  if (!expence.payments?.length && expence.status === 'Pending' && paidAmount === 0 && dueAmount === 0) {
    dueAmount = total;
  }
  if (!expence.payments?.length && expence.status === 'Paid' && paidAmount === 0 && dueAmount === 0) {
    paidAmount = total;
    dueAmount = 0;
  }

  if (expence.status === 'Paid') {
    paidAmount = Math.min(total, paidAmount > 0 ? paidAmount : total);
    dueAmount = 0;
  } else if (expence.status === 'Pending' && dueAmount <= 0 && paidAmount < total) {
    dueAmount = round2(total - paidAmount);
  }

  return {total, paidAmount, dueAmount};
};

const buildChannelAmounts = ({amount, mode, isMultiMode, paymentBreakdown = {}}) => {
  const payAmount = round2(amount);
  if (isMultiMode) {
    return {
      cash: round2(paymentBreakdown.cash),
      upi: round2(paymentBreakdown.upi),
      card: round2(paymentBreakdown.card),
      wallet: round2(paymentBreakdown.wallet),
    };
  }
  return {
    cash: mode === 'Cash' ? payAmount : 0,
    upi: mode === 'UPI' ? payAmount : 0,
    card: mode === 'Card' ? payAmount : 0,
    wallet: mode === 'Wallet' ? payAmount : 0,
  };
};

const enrichExpence = expence => {
  if (!expence) return expence;
  const plain = typeof expence.toObject === 'function' ? expence.toObject() : {...expence};
  const {total, paidAmount, dueAmount} = normalizeDueFields(plain);
  return {
    ...plain,
    totalDueAmount: total,
    totalReceivedAmount: paidAmount,
    remainingAmount: dueAmount,
    paidAmount,
    dueAmount,
  };
};

const buildPayload = (body = {}, {isUpdate = false} = {}) => {
  const payload = {};

  if (!isUpdate || body.expenseCode !== undefined) payload.expenseCode = String(body.expenseCode ?? '').trim();
  if (!isUpdate || body.title !== undefined) payload.title = String(body.title ?? '').trim();
  if (!isUpdate || body.category !== undefined) payload.category = String(body.category ?? 'Other').trim() || 'Other';
  if (!isUpdate || body.categoryId !== undefined) {
    const categoryId = String(body.categoryId ?? '').trim();
    payload.categoryId = mongoose.Types.ObjectId.isValid(categoryId) ? categoryId : null;
  }
  if (!isUpdate || body.segment !== undefined || body.segement !== undefined) {
    payload.segment = String(body.segment ?? body.segement ?? '').trim();
  }
  if (!isUpdate || body.amount !== undefined) payload.amount = round2(Math.max(0, Number(body.amount ?? 0) || 0));
  if (!isUpdate || body.paidTo !== undefined) payload.paidTo = String(body.paidTo ?? '').trim();
  if (!isUpdate || body.vendorId !== undefined) {
    const vendorId = String(body.vendorId ?? '').trim();
    payload.vendorId = mongoose.Types.ObjectId.isValid(vendorId) ? vendorId : null;
  }
  if (!isUpdate || body.mode !== undefined) payload.mode = String(body.mode ?? 'Cash').trim() || 'Cash';
  if (!isUpdate || body.status !== undefined) payload.status = String(body.status ?? 'Paid').trim() || 'Paid';
  if (!isUpdate || body.date !== undefined) payload.date = body.date ? new Date(body.date) : new Date();
  if (!isUpdate || body.notes !== undefined) payload.notes = String(body.notes ?? '').trim();
  if (!isUpdate || body.receiptUrl !== undefined) payload.receiptUrl = String(body.receiptUrl ?? '').trim();

  return payload;
};

const validatePayload = payload => {
  if (!payload.title || !String(payload.title).trim()) return 'Title is required.';
  if (!Number.isFinite(Number(payload.amount)) || Number(payload.amount) < 0) return 'Amount must be a valid non-negative number.';
  if (payload.date && Number.isNaN(new Date(payload.date).getTime())) return 'Invalid date value.';
  return null;
};

export const getAllExpences = async (req, res) => {
  try {

    const search=String(req.query.search ?? '').trim();
    const fromDate=String(req.query.fromDate ?? '').trim();
    const toDate=String(req.query.toDate ?? '').trim();
    const limit=Math.min(Math.max(Number(req.query.limit)||200,1),6000);
    const query={};
    if(search){
      const regex=new RegExp(escapeRegex(search),'i');
      query.$or=[
        {expensesCode:regex},
        {title:regex},
        {category:regex},
        {paidTo:regex},
        {notes:regex},
      ]
    }
const dateFilter={};
    if(fromDate){
  const from = new Date(`${fromDate}T00:00:00.000`);
      if (!Number.isNaN(from.getTime())) dateFilter.$gte = from;
    }

     if (toDate) {
      const to = new Date(`${toDate}T23:59:59.999`);
      if (!Number.isNaN(to.getTime())) dateFilter.$lte = to;
    }
    if (Object.keys(dateFilter).length) {
      query.date = dateFilter;
    }

    const expences =await Expence.find(query)
    .sort({date: -1, createdAt: -1})
    .limit(limit)
    .lean();

    return res.status(200).json({
      success:true,
      message:'Expenses fetched successfully.',
     expences: expences.map(enrichExpence),
      total: expences.length,
      limit,
    })
    
  } catch (error) {
    console.error('getAllExpences error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch expenses.',
    });
  }
};

export const getExpencesById = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid expense id.'});
    }

    const expence = await Expence.findById(id).lean();
    if (!expence) {
      return res.status(404).json({success: false, message: 'Expense not found.'});
    }

    return res.status(200).json({success: true, expence: enrichExpence(expence)});
  } catch (error) {
    console.error('getExpencesById error:', error);
    return res.status(500).json({success: false, message: error.message || 'Failed to fetch expense.'});
  }
};

export const addExpencesById = async (req, res) => {
  try {
    const payload = buildPayload(req.body, {isUpdate: false});
    const invalid = validatePayload(payload);
    if (invalid) {
      return res.status(400).json({success: false, message: invalid});
    }

    const receiptUrl = await resolveReceiptUrl(req);
    if (req.file && !receiptUrl) {
      return res.status(500).json({
        success: false,
        message: 'Failed to upload receipt image to Cloudinary.',
      });
    }
    if (receiptUrl) payload.receiptUrl = receiptUrl;

    const createdBy = parseMaybeJson(req.body?.createdBy) ?? {
      m_staff_id: req.user?.userId ?? null,
      m_staff_name: req.user?.name ?? null,
      m_staff_email: req.user?.email ?? null,
    };
    const addedBy = parseMaybeJson(req.body?.addedBy) ?? {
      m_staff_id: req.user?.userId ?? null,
      m_staff_name: req.user?.name ?? null,
      m_staff_email: req.user?.email ?? null,
    };
    const paidBy = parseMaybeJson(req.body?.paidBy) ?? {
      m_staff_id: addedBy?.m_staff_id ?? req.user?.userId ?? null,
      m_staff_name: addedBy?.m_staff_name ?? req.user?.name ?? null,
      m_staff_email: addedBy?.m_staff_email ?? req.user?.email ?? null,
    };

    const total = payload.amount;
    const hasPaidField = req.body?.paidAmount !== undefined && req.body?.paidAmount !== '';
    const hasDueField = req.body?.dueAmount !== undefined && req.body?.dueAmount !== '';
    let paidAmount = hasPaidField ? round2(req.body.paidAmount) : null;
    let dueAmount = hasDueField ? round2(req.body.dueAmount) : null;

    if (paidAmount == null && dueAmount == null) {
      if (payload.status === 'Pending') {
        paidAmount = 0;
        dueAmount = total;
      } else {
        paidAmount = total;
        dueAmount = 0;
      }
    } else {
      paidAmount = round2(paidAmount || 0);
      dueAmount = round2(dueAmount ?? Math.max(0, total - paidAmount));
    }

    if (paidAmount + dueAmount > total + 0.01) {
      return res.status(400).json({
        success: false,
        message: 'Paid amount and due amount cannot exceed the expense total.',
      });
    }

    payload.paidAmount = paidAmount;
    payload.dueAmount = dueAmount;

    const incomingBreakdown = parseMaybeJson(req.body?.paymentBreakdown) ?? {};
    payload.paymentBreakdown = {
      cash: round2(incomingBreakdown.cash),
      upi: round2(incomingBreakdown.upi),
      card: round2(incomingBreakdown.card),
      wallet: round2(incomingBreakdown.wallet),
    };

    const payments = [];
    if (paidAmount > 0) {
      const initialPayment = parseMaybeJson(req.body?.initialPayment) ?? {};
      const isMulti = Boolean(initialPayment.isMultiMode) || initialPayment.mode === 'Multi';
      const channelAmounts = buildChannelAmounts({
        amount: paidAmount,
        mode: initialPayment.mode || payload.mode,
        isMultiMode: isMulti,
        paymentBreakdown: initialPayment.paymentBreakdown || payload.paymentBreakdown,
      });
      payments.push({
        amount: paidAmount,
        mode: isMulti ? 'Multi' : initialPayment.mode || payload.mode || 'Cash',
        paymentBreakdown: channelAmounts,
        receivedBy: initialPayment.receivedBy || createdBy,
        notes: String(initialPayment.notes ?? '').trim(),
        paidAt: initialPayment.paidAt ? new Date(initialPayment.paidAt) : new Date(),
      });
    }

    const expence = await Expence.create({...payload, createdBy, addedBy, paidBy, payments});
    return res.status(201).json({
      success: true,
      message: 'Expense created successfully.',
      expence: enrichExpence(expence),
    });
  } catch (error) {
    console.error('addExpencesById error:', error);
    return res.status(500).json({success: false, message: error.message || 'Failed to create expense.'});
  }
};

export const updateExpencesById = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid expense id.'});
    }

    const existing = await Expence.findById(id);
    if (!existing) {
      return res.status(404).json({success: false, message: 'Expense not found.'});
    }

    const payload = buildPayload(req.body, {isUpdate: true});
    const receiptUrl = await resolveReceiptUrl(req);
    if (req.file && !receiptUrl) {
      return res.status(500).json({
        success: false,
        message: 'Failed to upload receipt image to Cloudinary.',
      });
    }
    if (receiptUrl) payload.receiptUrl = receiptUrl;

    const paidBy = parseMaybeJson(req.body?.paidBy);
    if (paidBy && typeof paidBy === 'object') {
      payload.paidBy = {
        m_staff_id: paidBy.m_staff_id ?? null,
        m_staff_name: paidBy.m_staff_name ?? null,
        m_staff_email: paidBy.m_staff_email ?? null,
      };
    }

    if (Object.keys(payload).length === 0) {
      return res.status(400).json({success: false, message: 'No valid fields to update.'});
    }

    const merged = {...existing.toObject(), ...payload};
    const invalid = validatePayload(merged);
    if (invalid) {
      return res.status(400).json({success: false, message: invalid});
    }

    Object.assign(existing, payload);
    await existing.save();
    return res.status(200).json({
      success: true,
      message: 'Expense updated successfully.',
      expence: enrichExpence(existing),
    });
  } catch (error) {
    console.error('updateExpencesById error:', error);
    return res.status(500).json({success: false, message: error.message || 'Failed to update expense.'});
  }
};

export const deleteExpencesById = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid expense id.'});
    }

    const deleted = await Expence.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({success: false, message: 'Expense not found.'});
    }

    return res.status(200).json({success: true, message: 'Expense deleted successfully.'});
  } catch (error) {
    console.error('deleteExpencesById error:', error);
    return res.status(500).json({success: false, message: error.message || 'Failed to delete expense.'});
  }
};

export const recordExpencePayment = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid expense id.'});
    }

    const expence = await Expence.findById(id);
    if (!expence) {
      return res.status(404).json({success: false, message: 'Expense not found.'});
    }
    if (expence.status === 'Cancelled') {
      return res.status(400).json({success: false, message: 'Cannot record payment on a cancelled expense.'});
    }

    const {total, paidAmount: currentPaid, dueAmount: currentDue} = normalizeDueFields(expence);
    if (currentDue <= 0) {
      return res.status(400).json({success: false, message: 'This expense is already fully paid.'});
    }

    const isMultiMode = Boolean(req.body?.isMultiMode) || req.body?.mode === 'Multi';
    const mode = String(req.body?.mode ?? 'Cash').trim() || 'Cash';
    const paymentBreakdown = parseMaybeJson(req.body?.paymentBreakdown) ?? {};
    const channelAmounts = buildChannelAmounts({
      amount: req.body?.amount,
      mode,
      isMultiMode,
      paymentBreakdown,
    });
    const paymentAmount = round2(
      isMultiMode
        ? channelAmounts.cash + channelAmounts.upi + channelAmounts.card + channelAmounts.wallet
        : req.body?.amount,
    );

    if (paymentAmount <= 0) {
      return res.status(400).json({success: false, message: 'Payment amount must be greater than 0.'});
    }
    if (paymentAmount > currentDue + 0.01) {
      return res.status(400).json({
        success: false,
        message: `Payment cannot exceed remaining due amount (₹${currentDue}).`,
      });
    }

    const receivedBy = parseMaybeJson(req.body?.receivedBy) ?? {
      m_staff_id: req.user?.userId ?? null,
      m_staff_name: req.user?.name ?? null,
      m_staff_email: req.user?.email ?? null,
    };

    const paymentRecord = {
      amount: paymentAmount,
      mode: isMultiMode ? 'Multi' : mode,
      paymentBreakdown: channelAmounts,
      receivedBy,
      notes: String(req.body?.notes ?? '').trim(),
      paidAt: req.body?.paidAt ? new Date(req.body.paidAt) : new Date(),
    };

    const pb = expence.paymentBreakdown || {};
    expence.paymentBreakdown = {
      cash: round2((pb.cash || 0) + channelAmounts.cash),
      upi: round2((pb.upi || 0) + channelAmounts.upi),
      card: round2((pb.card || 0) + channelAmounts.card),
      wallet: round2((pb.wallet || 0) + channelAmounts.wallet),
    };
    expence.paidAmount = round2(currentPaid + paymentAmount);
    expence.dueAmount = round2(Math.max(0, total - expence.paidAmount));
    expence.payments.push(paymentRecord);

    if (expence.dueAmount <= 0) {
      expence.status = 'Paid';
      expence.mode = resolveExpenseMode(expence.paymentBreakdown, isMultiMode ? 'Cash' : mode);
    } else {
      expence.status = 'Pending';
      expence.mode = 'Due';
    }

    await expence.save();

    return res.status(200).json({
      success: true,
      message: 'Payment recorded successfully.',
      expence: enrichExpence(expence),
      payment: paymentRecord,
    });
  } catch (error) {
    console.error('recordExpencePayment error:', error);
    return res.status(500).json({success: false, message: error.message || 'Failed to record payment.'});
  }
};

// Backward-compatible aliases (if any older files import these names)
export const createExpence = addExpencesById;
export const getExpences = getAllExpences;

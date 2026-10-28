import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import {fileURLToPath} from 'url';
import {uploadOnCloudinary} from '../utils/cloudinary.js';
import Vendor from '../models/vendor.model.js';
import Purchase from '../models/purchase.model.js';
import PurchaseOrder from '../models/purchaseOrder.model.js';
import PurchaseReturn from '../models/purchaseReturn.model.js';
import VendorPayment from '../models/vendorPayment.model.js';
import VendorActivity from '../models/vendorActivity.model.js';
import Expence from '../models/expence.model.js';
import CustomersailorProgram from '../models/customerSellerProgram.model.js';

const CLOSED = ['cancelled', 'draft'];
const METHODS = new Set(['Cash', 'UPI', 'Card', 'Bank', 'Other']);

const roundMoney = value => Math.round((Number(value) || 0) * 100) / 100;

const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const actorFrom = req => ({
  m_staff_id: req.staff?.m_staff_id || (req.staff?._id ? String(req.staff._id) : null),
  m_staff_name: req.staff?.fullName || null,
  m_staff_email: req.staff?.email || null,
});

const loadVendor = async id => {
  if (!mongoose.Types.ObjectId.isValid(id)) return {error: 'Invalid vendor id.', status: 400};
  const vendor = await Vendor.findById(id).lean();
  if (!vendor) return {error: 'Vendor not found.', status: 404};
  return {vendor};
};

const vendorMatch = vendor => {
  const names = [vendor.name, vendor.companyName]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  const clauses = names.map(name => ({
    supplierName: new RegExp(`^${escapeRegex(name)}$`, 'i'),
  }));
  const phones = [vendor.mobile, vendor.businessPhoneNumber]
    .map(value => String(value || '').replace(/\D/g, '').slice(-10))
    .filter(phone => phone.length >= 10);
  for (const phone of [...new Set(phones)]) {
    clauses.push({supplierContact: new RegExp(phone.split('').join('\\D*'))});
  }
  if (!clauses.length) return {_id: null};
  return {$or: clauses};
};

const active = docs => docs.filter(doc => !CLOSED.includes(String(doc.status || '').toLowerCase()));

const dueOn = (doc, dueDays) => {
  const base = new Date(doc.invoiceDate || doc.vendorDate || doc.createdAt);
  if (Number.isNaN(base.getTime())) return null;
  const extra = Number(dueDays);
  const days = Number.isFinite(extra) && extra > 0 ? extra : 0;
  const due = new Date(base);
  due.setDate(due.getDate() + days);
  due.setHours(23, 59, 59, 999);
  return due;
};

const mapBill = (doc, dueDays) => {
  const dueDate = dueOn(doc, dueDays);
  const dueAmount = roundMoney(doc.dueAmount);
  const overdue = dueAmount > 0 && dueDate && dueDate.getTime() < Date.now();
  return {
    id: String(doc._id),
    invoiceNumber: doc.invoiceNumber || '',
    invoiceDate: doc.invoiceDate || doc.vendorDate || doc.createdAt || null,
    createdAt: doc.createdAt || null,
    amount: roundMoney(doc.amount),
    paidAmount: roundMoney(doc.paidAmount),
    dueAmount,
    status: doc.status || '',
    paymentMode: doc.paymentMode || '',
    purchaseType: doc.purchaseType || '',
    overdue,
    dueDate,
  };
};

const buildSummary = (vendor, purchases, orders, returns, payments) => {
  const bills = active(purchases);
  const openOrders = active(orders);
  const openReturns = active(returns);
  const purchaseTotal = roundMoney(bills.reduce((sum, row) => sum + (Number(row.amount) || 0), 0));
  const purchaseDue = roundMoney(bills.reduce((sum, row) => sum + (Number(row.dueAmount) || 0), 0));
  const paidOnBills = roundMoney(bills.reduce((sum, row) => sum + (Number(row.paidAmount) || 0), 0));
  const returnTotal = roundMoney(openReturns.reduce((sum, row) => sum + (Number(row.amount) || 0), 0));
  const orderTotal = roundMoney(openOrders.reduce((sum, row) => sum + (Number(row.amount) || 0), 0));
  const openingBalance = roundMoney(vendor.openingBalance);
  let advance = 0;
  let payIn = 0;
  let adjustment = 0;
  let paidOut = 0;
  for (const payment of payments) {
    const amount = roundMoney(payment.amount);
    if (payment.direction === 'pay-out') {
      paidOut += amount;
      advance += roundMoney(payment.advanceAmount);
    } else if (payment.direction === 'pay-in') {
      payIn += amount;
    } else if (payment.direction === 'adjustment') {
      adjustment += payment.adjustmentEffect === 'decrease' ? -amount : amount;
    }
  }
  const payable = roundMoney(openingBalance + purchaseTotal - returnTotal);
  const outstanding = roundMoney(openingBalance + purchaseDue - returnTotal - advance - payIn + adjustment);
  const overdue = roundMoney(
    bills.reduce((sum, row) => {
      const dueDate = dueOn(row, vendor.defaultDueDays);
      const due = roundMoney(row.dueAmount);
      return due > 0 && dueDate && dueDate.getTime() < Date.now() ? sum + due : sum;
    }, 0),
  );
  return {
    purchaseTotal,
    purchaseCount: bills.length,
    orderTotal,
    orderCount: openOrders.length,
    returnTotal,
    returnCount: openReturns.length,
    paidOnBills: roundMoney(paidOnBills),
    paidOut: roundMoney(paidOut),
    openingBalance,
    advance: roundMoney(advance),
    payIn: roundMoney(payIn),
    adjustment: roundMoney(adjustment),
    payable,
    pending: outstanding > 0 ? outstanding : 0,
    credit: outstanding < 0 ? roundMoney(Math.abs(outstanding)) : 0,
    overdue,
    outstanding,
  };
};

const serializePayment = payment => ({
  id: String(payment._id),
  direction: payment.direction,
  adjustmentEffect: payment.adjustmentEffect || '',
  amount: roundMoney(payment.amount),
  appliedAmount: roundMoney(payment.appliedAmount),
  advanceAmount: roundMoney(payment.advanceAmount),
  method: payment.method || '',
  reference: payment.reference || '',
  note: payment.note || '',
  paidAt: payment.paidAt || payment.createdAt,
  createdAt: payment.createdAt || null,
  purchaseId: payment.purchaseId ? String(payment.purchaseId) : '',
  purchaseInvoice: payment.purchaseInvoice || '',
  createdBy: payment.createdBy?.m_staff_name || '',
  allocations: Array.isArray(payment.allocations)
    ? payment.allocations.map(row => ({
        purchaseId: row.purchaseId ? String(row.purchaseId) : '',
        purchaseInvoice: row.purchaseInvoice || '',
        amount: roundMoney(row.amount),
      }))
    : [],
  documents: Array.isArray(payment.documents)
    ? payment.documents.map(row => ({
        url: row.url || '',
        name: row.name || '',
        mimeType: row.mimeType || '',
        size: Number(row.size) || 0,
      }))
    : [],
});

export const getVendor360 = async (req, res) => {
  try {
    const loaded = await loadVendor(req.params.id);
    if (loaded.error) return res.status(loaded.status).json({success: false, message: loaded.error});
    const match = vendorMatch(loaded.vendor);
    const [purchases, orders, returns, payments] = await Promise.all([
      Purchase.find(match).sort({invoiceDate: -1}).lean(),
      PurchaseOrder.find(match).sort({invoiceDate: -1}).lean(),
      PurchaseReturn.find(match).sort({invoiceDate: -1}).lean(),
      VendorPayment.find({vendorId: loaded.vendor._id}).sort({paidAt: -1, createdAt: -1}).lean(),
    ]);
    const dueDays = loaded.vendor.defaultDueDays;
    const [enrollment, activities, expenses] = await Promise.all([
      CustomersailorProgram.findOne({vendorId: loaded.vendor._id, status: 'active'}).select('displayName createdAt updatedAt').lean(),
      VendorActivity.find({vendorId: loaded.vendor._id}).sort({at: -1}).limit(80).lean(),
      Expence.find({vendorId: loaded.vendor._id, status: {$ne: 'Cancelled'}}).sort({date: -1}).limit(80).lean(),
    ]);
    const cspLabel = enrollment
      ? `CSP · ${String(enrollment.displayName || loaded.vendor.name || 'Sailor').trim()}`
      : '';
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;
    const inPeriod = date => {
      if (!from && !to) return true;
      const value = new Date(date || 0).getTime();
      if (Number.isNaN(value)) return false;
      if (from && !Number.isNaN(from.getTime()) && value < from.getTime()) return false;
      if (to && !Number.isNaN(to.getTime())) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        if (value > end.getTime()) return false;
      }
      return true;
    };
    const summary = buildSummary(loaded.vendor, purchases, orders, returns, payments);
    const confirmed = active(purchases);
    const periodBills = confirmed.filter(row => inPeriod(row.invoiceDate || row.createdAt));
    const lastPurchase = confirmed.reduce((latest, row) => {
      const when = row.invoiceDate || row.createdAt;
      if (!when) return latest;
      if (!latest || new Date(when) > new Date(latest.when)) {
        return {when, createdAt: row.createdAt || null};
      }
      return latest;
    }, null);
    summary.purchaseFrequency = periodBills.length;
    summary.lastPurchaseDate = lastPurchase?.when || null;
    summary.lastPurchaseCreatedAt = lastPurchase?.createdAt || null;
    summary.totalPaid = summary.paidOnBills;
    const timeline = [
      {
        id: `created-${loaded.vendor._id}`,
        type: 'vendor',
        title: 'Vendor created',
        detail: loaded.vendor.name || '',
        amount: 0,
        reference: '',
        at: loaded.vendor.createdAt,
        createdAt: loaded.vendor.createdAt,
        by: '',
      },
      ...activities.map(row => ({
        id: String(row._id),
        type: row.type || 'updated',
        title: row.title,
        detail: row.detail || '',
        amount: roundMoney(row.amount),
        reference: row.reference || '',
        at: row.at || row.createdAt,
        createdAt: row.createdAt || row.at,
        by: row.by?.m_staff_name || '',
      })),
      ...(enrollment
        ? [{
            id: `csp-${enrollment._id}`,
            type: 'csp',
            title: 'CSP label assigned',
            detail: cspLabel,
            amount: 0,
            reference: '',
            at: enrollment.createdAt,
            createdAt: enrollment.createdAt,
            by: '',
          }]
        : []),
      ...confirmed.map(row => ({
        id: `purchase-${row._id}`,
        type: 'purchase',
        title: 'Purchase created',
        detail: row.invoiceNumber || '',
        amount: roundMoney(row.amount),
        reference: row.invoiceNumber || '',
        at: row.invoiceDate || row.createdAt,
        createdAt: row.createdAt,
        by: row.createdBy?.m_staff_name || '',
      })),
      ...active(orders).map(row => ({
        id: `order-${row._id}`,
        type: 'order',
        title: 'Purchase order created',
        detail: row.invoiceNumber || '',
        amount: roundMoney(row.amount),
        reference: row.invoiceNumber || '',
        at: row.invoiceDate || row.createdAt,
        createdAt: row.createdAt,
        by: row.createdBy?.m_staff_name || '',
      })),
      ...payments.map(row => ({
        id: `payment-${row._id}`,
        type: 'payment',
        title: row.direction === 'pay-out'
          ? (roundMoney(row.appliedAmount) > 0 && roundMoney(row.appliedAmount) + 0.5 < roundMoney(row.amount) ? 'Partial payment recorded' : 'Payment recorded')
          : row.direction === 'pay-in' ? 'Pay-in recorded' : 'Balance adjusted',
        detail: [row.method, row.reference, row.purchaseInvoice, row.documents?.length ? 'Receipt attached' : ''].filter(Boolean).join(' · '),
        amount: roundMoney(row.amount),
        reference: row.reference || row.purchaseInvoice || '',
        at: row.paidAt || row.createdAt,
        createdAt: row.createdAt,
        by: row.createdBy?.m_staff_name || '',
      })),
      ...expenses.map(row => ({
        id: `expense-${row._id}`,
        type: 'expense',
        title: 'Expense created',
        detail: row.title || '',
        amount: roundMoney(row.amount),
        reference: row.expenseCode || '',
        at: row.date || row.createdAt,
        createdAt: row.createdAt,
        by: row.createdBy?.m_staff_name || row.addedBy?.m_staff_name || '',
      })),
    ]
      .filter(row => row.at)
      .sort((a, b) => new Date(b.at) - new Date(a.at));
    return res.status(200).json({
      success: true,
      vendor: {...loaded.vendor, cspLabel},
      summary,
      purchases: confirmed.map(row => mapBill(row, dueDays)),
      orders: active(orders).map(row => mapBill(row, dueDays)),
      returns: active(returns).map(row => mapBill(row, dueDays)),
      payments: payments.map(serializePayment),
      timeline,
    });
  } catch (error) {
    console.error('getVendor360 error:', error);
    return res.status(500).json({success: false, message: 'Could not load the vendor view.'});
  }
};

const belongsToVendor = (doc, vendor) => {
  const supplier = String(doc.supplierName || '').trim().toLowerCase();
  const names = [vendor.name, vendor.companyName]
    .map(value => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  if (supplier && names.includes(supplier)) return true;
  const phone = String(vendor.mobile || '').replace(/\D/g, '').slice(-10);
  const contact = String(doc.supplierContact || '').replace(/\D/g, '');
  return phone.length >= 10 && contact.endsWith(phone);
};

export const recordVendorPayment = async (req, res) => {
  try {
    const loaded = await loadVendor(req.params.id);
    if (loaded.error) return res.status(loaded.status).json({success: false, message: loaded.error});
    const vendor = loaded.vendor;
    const direction = String(req.body?.direction || '').trim();
    if (!['pay-out', 'pay-in', 'adjustment'].includes(direction)) {
      return res.status(400).json({success: false, message: 'Choose pay-out, pay-in, or an adjustment.'});
    }
    const amount = roundMoney(req.body?.amount);
    if (!(amount > 0)) {
      return res.status(400).json({success: false, message: 'Enter an amount greater than zero.'});
    }
    const method = String(req.body?.method || '').trim();
    if (direction !== 'adjustment' && !METHODS.has(method)) {
      return res.status(400).json({success: false, message: 'Choose a payment method.'});
    }
    let adjustmentEffect = '';
    if (direction === 'adjustment') {
      adjustmentEffect = String(req.body?.adjustmentEffect || '').trim();
      if (adjustmentEffect !== 'increase' && adjustmentEffect !== 'decrease') {
        return res.status(400).json({success: false, message: 'Choose whether the adjustment increases or decreases the balance.'});
      }
    }
    const clientKey = String(req.body?.clientKey || '').trim().slice(0, 80);
    if (clientKey) {
      const existing = await VendorPayment.findOne({vendorId: vendor._id, clientKey}).lean();
      if (existing) {
        return res.status(200).json({success: true, payment: serializePayment(existing), duplicate: true});
      }
    }

    const paidAt = req.body?.paidAt ? new Date(req.body.paidAt) : new Date();
    if (Number.isNaN(paidAt.getTime())) {
      return res.status(400).json({success: false, message: 'Enter a valid payment date.'});
    }

    let appliedAmount = 0;
    let advanceAmount = direction === 'pay-out' ? amount : 0;
    let purchaseInvoice = '';
    let purchaseId = null;
    const rolledBack = [];
    const allocations = [];

    const requestedIds = [
      ...(Array.isArray(req.body?.purchaseIds) ? req.body.purchaseIds : []),
      req.body?.purchaseId,
    ]
      .map(value => String(value || '').trim())
      .filter((value, index, list) => value && list.indexOf(value) === index);

    if (requestedIds.length) {
      if (direction !== 'pay-out') {
        return res.status(400).json({success: false, message: 'Only a pay-out can be applied to a purchase bill.'});
      }
      const bills = [];
      for (const requestedPurchase of requestedIds) {
        if (!mongoose.Types.ObjectId.isValid(requestedPurchase)) {
          return res.status(400).json({success: false, message: 'That purchase bill was not found.'});
        }
        const purchase = await Purchase.findById(requestedPurchase);
        if (!purchase || !belongsToVendor(purchase, vendor)) {
          return res.status(404).json({success: false, message: 'That purchase bill was not found for this vendor.'});
        }
        if (CLOSED.includes(String(purchase.status || '').toLowerCase())) {
          return res.status(400).json({success: false, message: 'This bill cannot accept a payment.'});
        }
        const due = roundMoney(purchase.dueAmount);
        if (due <= 0) {
          return res.status(400).json({success: false, message: `${purchase.invoiceNumber || 'A selected bill'} has no outstanding balance.`});
        }
        bills.push(purchase);
      }
      const eligible = roundMoney(bills.reduce((sum, row) => sum + roundMoney(row.dueAmount), 0));
      if (amount > eligible + 0.5) {
        return res.status(400).json({
          success: false,
          message: `Payment cannot exceed the outstanding amount of ${eligible}.`,
        });
      }
      let remaining = amount;
      for (const purchase of bills) {
        if (remaining <= 0) break;
        const due = roundMoney(purchase.dueAmount);
        const slice = roundMoney(Math.min(remaining, due));
        const nextPaid = roundMoney((Number(purchase.paidAmount) || 0) + slice);
        const nextDue = roundMoney(Math.max(0, (Number(purchase.amount) || 0) - nextPaid));
        const settled = nextDue <= 0.5;
        const updated = await Purchase.findOneAndUpdate(
          {_id: purchase._id, dueAmount: {$gte: slice - 0.01}},
          {
            $set: {
              paidAmount: settled ? roundMoney(purchase.amount) : nextPaid,
              dueAmount: settled ? 0 : nextDue,
              status: settled ? 'paid' : 'partial',
              paymentMode: method,
              purchaseType: 'cash',
            },
          },
          {new: true},
        );
        if (!updated) {
          for (const previous of rolledBack) {
            await Purchase.updateOne({_id: previous.id}, {$set: {
              paidAmount: previous.paidAmount,
              dueAmount: previous.dueAmount,
              status: previous.status,
              paymentMode: previous.paymentMode,
              purchaseType: previous.purchaseType,
            }});
          }
          return res.status(409).json({success: false, message: 'A selected bill was updated by another payment. Refresh and try again.'});
        }
        rolledBack.push({
          id: purchase._id,
          paidAmount: purchase.paidAmount,
          dueAmount: purchase.dueAmount,
          status: purchase.status,
          paymentMode: purchase.paymentMode,
          purchaseType: purchase.purchaseType,
        });
        allocations.push({
          purchaseId: purchase._id,
          purchaseInvoice: purchase.invoiceNumber || '',
          amount: slice,
        });
        appliedAmount = roundMoney(appliedAmount + slice);
        remaining = roundMoney(remaining - slice);
      }
      advanceAmount = 0;
      purchaseId = allocations[0]?.purchaseId || null;
      purchaseInvoice = allocations.map(row => row.purchaseInvoice).filter(Boolean).join(', ');
    }

    const documents = (Array.isArray(req.body?.documents) ? req.body.documents : [])
      .map(row => ({
        url: String(row?.url || '').trim().slice(0, 500),
        name: String(row?.name || '').trim().slice(0, 180),
        mimeType: String(row?.mimeType || '').trim().slice(0, 80),
        size: Math.max(0, Number(row?.size) || 0),
      }))
      .filter(row => row.url)
      .slice(0, 5);

    try {
      const payment = await VendorPayment.create({
        vendorId: vendor._id,
        direction,
        adjustmentEffect,
        amount,
        appliedAmount,
        advanceAmount: direction === 'pay-out' ? advanceAmount : 0,
        method: direction === 'adjustment' ? '' : method,
        reference: String(req.body?.reference || '').trim().slice(0, 120),
        note: String(req.body?.note || '').trim().slice(0, 500),
        paidAt,
        purchaseId,
        purchaseInvoice,
        allocations,
        documents,
        history: [{
          action: 'created',
          amount,
          note: String(req.body?.note || '').trim().slice(0, 200),
          at: new Date(),
          byName: actorFrom(req).m_staff_name || '',
        }],
        clientKey,
        createdBy: actorFrom(req),
      });
      const payments = await VendorPayment.find({vendorId: vendor._id}).lean();
      const purchases = await Purchase.find(vendorMatch(vendor)).select('amount paidAmount dueAmount status invoiceDate vendorDate').lean();
      const returns = await PurchaseReturn.find(vendorMatch(vendor)).select('amount status').lean();
      const summary = buildSummary(vendor, purchases, [], returns, payments);
      await Vendor.updateOne(
        {_id: vendor._id},
        {$set: {netBalance: summary.outstanding, closingBalance: summary.outstanding}},
      );
      return res.status(201).json({
        success: true,
        payment: serializePayment(payment.toObject()),
        summary,
      });
    } catch (error) {
      if (rolledBack.length) {
        for (const previous of rolledBack) {
          await Purchase.updateOne({_id: previous.id}, {$set: {
            paidAmount: previous.paidAmount,
            dueAmount: previous.dueAmount,
            status: previous.status,
            paymentMode: previous.paymentMode,
            purchaseType: previous.purchaseType,
          }});
        }
      }
      if (error?.code === 11000) {
        const existing = await VendorPayment.findOne({vendorId: vendor._id, clientKey}).lean();
        if (existing) {
          return res.status(200).json({success: true, payment: serializePayment(existing), duplicate: true});
        }
      }
      throw error;
    }
  } catch (error) {
    console.error('recordVendorPayment error:', error);
    return res.status(500).json({success: false, message: 'Could not record the payment.'});
  }
};

const localUploadsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../uploads/vendor-payments');
const tmpUploadsDir = path.join('/tmp', 'uploads', 'vendor-payments');

let uploadRoot = localUploadsDir;
try {
  fs.mkdirSync(localUploadsDir, {recursive: true});
} catch {
  fs.mkdirSync(tmpUploadsDir, {recursive: true});
  uploadRoot = tmpUploadsDir;
}

export const paymentDocumentUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadRoot),
    filename: (_req, file, callback) => {
      const safe = String(file.originalname || 'receipt').replace(/[^\w.\-]+/g, '_').slice(0, 80);
      callback(null, `${Date.now()}-${safe}`);
    },
  }),
  limits: {fileSize: 5 * 1024 * 1024},
  fileFilter: (_req, file, callback) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowed.includes(file.mimetype)) {
      callback(new Error('Upload a JPG, PNG, WEBP, or PDF up to 5 MB.'));
      return;
    }
    callback(null, true);
  },
}).single('file');

export const uploadVendorPaymentDocument = async (req, res) => {
  try {
    const loaded = await loadVendor(req.params.id);
    if (loaded.error) return res.status(loaded.status).json({success: false, message: loaded.error});
    if (!req.file) {
      return res.status(400).json({success: false, message: 'Choose a file to upload.'});
    }
    const url = await uploadOnCloudinary(req.file.path, {folder: 'vendor-payments'});
    if (!url) {
      return res.status(502).json({success: false, message: 'The receipt could not be stored. Check cloud storage and try again.'});
    }
    return res.status(201).json({
      success: true,
      document: {
        url,
        name: req.file.originalname || 'receipt',
        mimeType: req.file.mimetype,
        size: req.file.size,
      },
    });
  } catch (error) {
    console.error('uploadVendorPaymentDocument error:', error);
    return res.status(500).json({success: false, message: error.message || 'Could not upload the receipt.'});
  }
};

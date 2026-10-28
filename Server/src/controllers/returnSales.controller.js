import mongoose from 'mongoose';
import Counter from '../models/counter.model.js';
import ReturnSale from '../models/returnSale.model.js';
import Invoice from '../models/invoice.model.js';
import Customer from '../models/customer.model.js';
import Wallet from '../models/wallet.model.js';
import {appendTransaction} from './wallet.controller.js';
import {
  reverseMembershipCashback,
  remainingCashbackToReverse,
} from '../services/membershipCashbackWallet.service.js';
import {
  validateReturnSaleCreateBody,
  validateReturnSaleUpdateBody,
} from '../schemas/returnSale.schema.js';

const round2 = n => Math.round((Number(n) || 0) * 100) / 100;

const getNextReturnNumber = async () => {
  const counter = await Counter.findOneAndUpdate(
    {key: 'return_sales_number'},
    {$inc: {value: 1}},
    {new: true, upsert: true, setDefaultsOnInsert: true},
  );
  return counter.value;
};

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Original amount the customer paid for the line. Never subtract discount from lineTotal. */
const originalLineNetPaid = item => {
  const qty = Number(item?.qty) || 0;
  const unitPrice = Number(item?.unitPrice) || 0;
  const discount = Number(item?.discount) || 0;
  const stored = Number(item?.lineTotal);
  if (Number.isFinite(stored) && stored >= 0) return stored;
  return Math.max(0, qty * unitPrice - discount);
};

const findCustomerForReturn = async ({customerId, customerPhone, customerName}) => {
  const id = String(customerId ?? '').trim();
  if (id && mongoose.Types.ObjectId.isValid(id)) {
    const byId = await Customer.findById(id);
    if (byId) return byId;
  }
  const phone = String(customerPhone ?? '').trim();
  const digits = phone.replace(/\D/g, '');
  if (digits) {
    const byPhone = await Customer.findOne({
      $or: [
        {mobile: phone},
        {mobile: digits},
        {mobile: `+91${digits}`},
        {mobile: `91${digits}`},
      ],
    });
    if (byPhone) return byPhone;
  }
  const name = String(customerName ?? '').trim();
  if (name) return Customer.findOne({name});
  return null;
};

const creditWalletForReturn = async ({customer, amount, returnCode, invoiceCode, createdBy}) => {
  const numericAmount = round2(amount);
  if (!customer?._id || !(numericAmount > 0)) return null;

  let wallet = await Wallet.findOne({customerId: customer._id});
  if (!wallet) {
    wallet = await Wallet.create({
      customerId: customer._id,
      customerName: String(customer.name ?? '').trim(),
      customerPhone: String(customer.mobile ?? '').trim(),
      walletAmount: 0,
      transactions: [],
    });
  }

  return appendTransaction(wallet, {
    type: 'credit',
    amount: numericAmount,
    walletType: 'nonWithdrawable',
    note: `Sales return ${returnCode} against invoice ${invoiceCode}`,
    referenceType: 'sales_return',
    referenceId: returnCode,
    createdBy,
  });
};

/**
 * Cashback to claw back for this return:
 * - Prefer line cashback × (returnQty / soldQty)
 * - Else proportion of remaining invoice cashback by returned value / original bill value
 */
const computeCashbackToReverseForReturn = (invoice, normalizedReturnItems) => {
  const remaining = remainingCashbackToReverse(invoice);
  if (!(remaining > 0)) return 0;

  let fromLines = 0;
  let usedLineCashback = false;
  for (const ret of normalizedReturnItems || []) {
    const idx = Number(ret.lineIndex);
    const source =
      Number.isInteger(idx) && idx >= 0 ? invoice.items?.[idx] : null;
    const lineCb = Math.max(0, Number(source?.cashback ?? 0) || 0);
    const soldQty = Math.max(0, Number(source?.qty ?? ret.originalQty) || 0);
    const retQty = Math.max(0, Number(ret.qty) || 0);
    if (lineCb > 0 && soldQty > 0 && retQty > 0) {
      usedLineCashback = true;
      fromLines += (lineCb / soldQty) * retQty;
    }
  }
  if (usedLineCashback) {
    return Math.min(remaining, round2(fromLines));
  }

  const originalNet = round2(
    (invoice.items || []).reduce((sum, item) => sum + originalLineNetPaid(item), 0),
  );
  const returnedNet = round2(
    (normalizedReturnItems || []).reduce(
      (sum, item) => sum + Number(item.refundAmount || item.lineTotal || 0),
      0,
    ),
  );
  if (!(originalNet > 0) || !(returnedNet > 0)) return 0;

  // Full return of remaining qty → reverse all remaining cashback (avoid rounding leftover)
  const allRemainingReturned = (invoice.items || []).every((item) => {
    const sold = Number(item.qty) || 0;
    const returned = Number(item.returnedQty) || 0;
    return sold <= 0 || returned >= sold;
  });
  if (allRemainingReturned) return remaining;

  return Math.min(remaining, round2(Number(invoice.cashbackTotal || 0) * (returnedNet / originalNet)));
};

const applyInvoiceReturnQuantities = async ({
  invoice,
  returnItems,
  refundBreakdown,
  refundMode,
  intent,
}) => {
  const items = Array.isArray(invoice.items) ? invoice.items : [];
  const usedIndexes = new Set();
  const normalizedReturnItems = [];

  for (const returnItem of returnItems) {
    let idx = Number.isInteger(returnItem.lineIndex) ? returnItem.lineIndex : -1;
    if (idx < 0 || idx >= items.length || usedIndexes.has(idx)) {
      idx = items.findIndex(
        (invItem, i) =>
          !usedIndexes.has(i) &&
          String(invItem.productName || '').trim() === String(returnItem.productName || '').trim(),
      );
    }
    if (idx < 0) {
      const error = new Error(`Invoice does not contain item "${returnItem.productName}".`);
      error.status = 400;
      throw error;
    }
    usedIndexes.add(idx);

    const source = items[idx];
    const purchasedQty = Number(source.qty) || 0;
    const alreadyReturned = Math.max(0, Number(source.returnedQty) || 0);
    const remaining = Math.max(0, purchasedQty - alreadyReturned);
    const returnQty = Number(returnItem.qty) || 0;
    if (returnQty <= 0) {
      const error = new Error(`Return quantity must be at least 1 for "${returnItem.productName}".`);
      error.status = 400;
      throw error;
    }
    if (returnQty > remaining) {
      const error = new Error(
        `Cannot return ${returnQty} of "${returnItem.productName}". Only ${remaining} remaining.`,
      );
      error.status = 400;
      throw error;
    }

    const isGift = Boolean(returnItem.isGift ?? source.isGift);
    const originalNet = originalLineNetPaid(source);
    const unitNet = purchasedQty > 0 ? originalNet / purchasedQty : 0;
    const refundAmount = isGift ? 0 : round2(unitNet * returnQty);
    const originalDiscount = Number(source.discount) || 0;
    const discountShare =
      purchasedQty > 0 ? round2((originalDiscount / purchasedQty) * returnQty) : 0;

    source.returnedQty = alreadyReturned + returnQty;
    source.isGift = isGift;
    items[idx] = source;

    normalizedReturnItems.push({
      ...returnItem,
      productName: String(source.productName || returnItem.productName || '').trim(),
      qty: returnQty,
      unitPrice: Number(source.unitPrice) || 0,
      discount: discountShare,
      lineIndex: idx,
      originalQty: purchasedQty,
      isGift,
      refundAmount,
      lineTotal: refundAmount,
    });
  }

  const itemsNet = round2(
    normalizedReturnItems.reduce((sum, item) => sum + Number(item.refundAmount || 0), 0),
  );
  const originalDiscountTotal = round2(
    normalizedReturnItems.reduce((sum, item) => sum + Number(item.discount || 0), 0),
  );
  /** Refund is original net paid × qty. Do not re-apply product/membership/coupon discounts. */
  const computedReturnValue = itemsNet;

  const paidAmount = round2(Number(invoice.paymentBreakdown?.paidAmount ?? 0) || 0);
  const alreadyRefunded = round2(Number(invoice.returnedAmount ?? 0) || 0);
  const pending = round2(Number(invoice.pendingAmount ?? invoice.paymentBreakdown?.dueAmount ?? 0) || 0);
  const dueReduce = round2(Math.min(pending, computedReturnValue));
  const maxCashRefund = round2(Math.max(0, paidAmount - alreadyRefunded));
  const refundable = round2(Math.min(maxCashRefund, Math.max(0, computedReturnValue - dueReduce)));

  const cash = round2(refundBreakdown?.cash);
  const upi = round2(refundBreakdown?.upi);
  const card = round2(refundBreakdown?.card);
  const wallet = round2(refundBreakdown?.wallet);
  const refundedNow = round2(cash + upi + card + wallet);
  const processRefund = Boolean(String(refundMode || '').trim()) || refundedNow > 0;

  if (processRefund && refundedNow > refundable + 0.05) {
    const error = new Error(
      `Refund ₹${refundedNow} exceeds refundable amount ₹${refundable}.`,
    );
    error.status = 400;
    throw error;
  }
  if (processRefund && refundable > 0 && Math.abs(refundedNow - refundable) > 0.05) {
    const error = new Error(
      `Refund must equal ₹${refundable} (wallet + cash + UPI + card).`,
    );
    error.status = 400;
    throw error;
  }

  const nextPending = round2(Math.max(0, pending - dueReduce));
  const nextReturnedAmount = round2(alreadyRefunded + computedReturnValue);
  const allReturned = items.every(
    item => Number(item.returnedQty || 0) >= Number(item.qty || 0),
  );
  const shouldCancel = intent === 'cancel' && allReturned;

  invoice.items = items;
  invoice.returnedAmount = nextReturnedAmount;
  invoice.pendingAmount = nextPending;
  if (invoice.paymentBreakdown) {
    invoice.paymentBreakdown.dueAmount = nextPending;
  }
  if (shouldCancel) {
    invoice.status = 'cancelled';
  }
  invoice.markModified('items');
  invoice.markModified('paymentBreakdown');
  await invoice.save();

  return {
    normalizedReturnItems,
    computedReturnValue,
    originalDiscountTotal,
    refundable,
    dueReduce,
    shouldCancel,
    nextPending,
  };
};

export const createReturnSale = async (req, res) => {
  try {
    const parsed = validateReturnSaleCreateBody(req.body);
    if (!parsed.ok) {
      return res.status(400).json({
        success: false,
        message: parsed.errors.join(' '),
        errors: parsed.errors,
      });
    }

    const nextNumber = await getNextReturnNumber();
    const returnPrefix = 'RSRVWAH';
    const returnCode = `${returnPrefix}-${nextNumber}`;

    const staffFromReq = {
      m_staff_id: req.user?.userId ?? null,
      m_staff_name: req.user?.name ?? null,
      m_staff_email: req.user?.email ?? null,
    };

    const createdBy = parsed.data.createdBy ?? staffFromReq;

    let originalInvoiceId = null;
    let originalInvoiceCode = parsed.data.originalInvoiceCode || '';
    let processedReturn = null;
    if (parsed.data.originalInvoiceId) {
      if (!mongoose.Types.ObjectId.isValid(parsed.data.originalInvoiceId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid originalInvoiceId.',
        });
      }
      originalInvoiceId = new mongoose.Types.ObjectId(parsed.data.originalInvoiceId);
    }

    let items = parsed.data.items;
    if (originalInvoiceId) {
      const invoice = await Invoice.findById(originalInvoiceId);
      if (!invoice) {
        return res.status(404).json({
          success: false,
          message: 'Original invoice not found.',
        });
      }
      if (invoice.status === 'cancelled') {
        return res.status(400).json({
          success: false,
          message: 'Cannot return items on a cancelled invoice.',
        });
      }
      originalInvoiceCode = originalInvoiceCode || invoice.invoiceCode || '';
      try {
        processedReturn = await applyInvoiceReturnQuantities({
          invoice,
          returnItems: parsed.data.items,
          refundBreakdown: parsed.data.refundBreakdown,
          refundMode: parsed.data.refundMode,
          intent: parsed.data.intent,
        });
        items = processedReturn.normalizedReturnItems;
      } catch (returnError) {
        const status = returnError.status || 400;
        return res.status(status).json({
          success: false,
          message: returnError.message || 'Failed to apply return quantities.',
        });
      }

      const refundWallet = round2(parsed.data.refundBreakdown?.wallet);
      const customer = await findCustomerForReturn({
        customerId: invoice.customerId,
        customerPhone: invoice.customerPhone,
        customerName: invoice.customerName,
      });
      if (refundWallet > 0) {
        if (!customer) {
          return res.status(400).json({
            success: false,
            message: 'Customer not found. Cannot add refund to wallet.',
          });
        }
        await creditWalletForReturn({
          customer,
          amount: refundWallet,
          returnCode,
          invoiceCode: originalInvoiceCode,
          createdBy,
        });
      }

      // Claw back membership cashback for returned lines (proportional / per-line)
      const cashbackToReverse = processedReturn.shouldCancel
        ? remainingCashbackToReverse(invoice)
        : computeCashbackToReverseForReturn(
            invoice,
            processedReturn.normalizedReturnItems,
          );
      if (cashbackToReverse > 0 && customer) {
        try {
          const result = await reverseMembershipCashback({
            customer,
            amount: cashbackToReverse,
            invoiceCode: originalInvoiceCode || invoice.invoiceCode,
            referenceId: `${returnCode}:cashback-return`,
            note: processedReturn.shouldCancel
              ? `Cashback reversed — invoice ${originalInvoiceCode || invoice.invoiceCode} cancelled via sales return ${returnCode}`
              : `Cashback reversed — sales return ${returnCode} against invoice ${originalInvoiceCode || invoice.invoiceCode}`,
            createdBy,
          });
          if (result.reversed > 0) {
            invoice.cashbackReversedTotal = round2(
              Number(invoice.cashbackReversedTotal || 0) + result.reversed,
            );
            await invoice.save();
          }
        } catch (cbError) {
          console.error('createReturnSale cashback reverse error:', cbError);
        }
      } else if (cashbackToReverse > 0 && !customer) {
        console.warn(
          '[createReturnSale] Cashback reverse skipped — customer not found',
          originalInvoiceCode,
        );
      }
    }

    const refundPaid = round2(
      Number(parsed.data.refundBreakdown?.cash || 0) +
        Number(parsed.data.refundBreakdown?.upi || 0) +
        Number(parsed.data.refundBreakdown?.card || 0) +
        Number(parsed.data.refundBreakdown?.wallet || 0),
    );

    const doc = await ReturnSale.create({
      returnPrefix,
      returnNumber: nextNumber,
      returnCode,
      customerName: parsed.data.customerName,
      customerPhone: parsed.data.customerPhone,
      invoiceDate: parsed.data.invoiceDate,
      dueDate: parsed.data.dueDate,
      salesPersonName: parsed.data.salesPersonName,
      billBy: parsed.data.billBy || '',
      invoiceBy: parsed.data.invoiceBy || {
        staffId: null,
        staffName: '',
        employeeId: '',
        email: '',
      },
      notes: parsed.data.notes,
      status: parsed.data.status,
      items,
      subTotal: processedReturn?.computedReturnValue ?? parsed.data.subTotal,
      discountTotal: processedReturn?.originalDiscountTotal ?? parsed.data.discountTotal,
      grandTotal: processedReturn?.computedReturnValue ?? parsed.data.grandTotal,
      originalInvoiceId,
      originalInvoiceCode,
      intent: parsed.data.intent || 'return',
      refundMode: parsed.data.refundMode || '',
      refundBreakdown: {
        ...parsed.data.refundBreakdown,
        paidAmount: refundPaid,
      },
      refundedAt: refundPaid > 0 ? new Date() : null,
      createdBy,
    });

    return res.status(201).json({
      success: true,
      message: 'Return sale created successfully.',
      returnSale: doc,
    });
  } catch (error) {
    console.error('createReturnSale error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to create return sale.',
    });
  }
};

export const getReturnSales = async (req, res) => {
  try {
    const fromDate = String(req.query.fromDate ?? '').trim();
    const toDate = String(req.query.toDate ?? '').trim();
    const search = String(req.query.search ?? '').trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const query = {};
    const dateFilter = {};
    if(fromDate){
      const from=new Date(`${fromDate}T00:00:00.000`);
      if(!Number.isNaN(from.getTime())) dateFilter.$gte=from;
    }

    if(toDate){
      const to=new Date(`${toDate}T23:59:59.999`);
      if(!Number.isNaN(to.getTime())) dateFilter.$lte=to;
    }
    if(Object.keys(dateFilter).length){
      query.createdAt=dateFilter;
    }

    if (search) {
      const regex = new RegExp(escapeRegex(search), 'i');
      query.$or = [
        {returnCode: regex},
        {customerName: regex},
        {customerPhone: regex},
        {originalInvoiceCode: regex},
      ];
    }

    const originalInvoiceId = String(req.query.originalInvoiceId ?? '').trim();
    if (originalInvoiceId) {
      if (!mongoose.Types.ObjectId.isValid(originalInvoiceId)) {
        return res.status(400).json({success: false, message: 'Invalid originalInvoiceId.'});
      }
      query.originalInvoiceId = originalInvoiceId;
    }

    const returnSales = await ReturnSale.find(query)
      .sort({createdAt: -1})
      .limit(limit)
      .lean();

    return res.status(200).json({
      success: true,
      message: 'Return sales fetched successfully.',
      returnSales,
      total: returnSales.length,
      limit,
    });
  } catch (error) {
    console.error('getReturnSales error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch return sales.',
    });
  }
};

export const getReturnSaleById = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid id.'});
    }

    const returnSale = await ReturnSale.findById(id).lean();
    if (!returnSale) {
      return res.status(404).json({success: false, message: 'Return sale not found.'});
    }

    return res.status(200).json({
      success: true,
      message: 'Return sale fetched successfully.',
      returnSale,
    });
  } catch (error) {
    console.error('getReturnSaleById error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch return sale.',
    });
  }
};

export const updateReturnSale = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid id.'});
    }

    const parsed = validateReturnSaleUpdateBody(req.body);
    if (!parsed.ok) {
      return res.status(400).json({
        success: false,
        message: parsed.errors.join(' '),
        errors: parsed.errors,
      });
    }

    const updateData = {...parsed.data};
    if (updateData.originalInvoiceId !== undefined) {
      const v = updateData.originalInvoiceId;
      if (v && !mongoose.Types.ObjectId.isValid(v)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid originalInvoiceId.',
        });
      }
      updateData.originalInvoiceId = v
        ? new mongoose.Types.ObjectId(v)
        : null;
    }

    const returnSale = await ReturnSale.findByIdAndUpdate(
      id,
      {$set: updateData},
      {new: true},
    );

    if (!returnSale) {
      return res.status(404).json({success: false, message: 'Return sale not found.'});
    }

    return res.status(200).json({
      success: true,
      message: 'Return sale updated successfully.',
      returnSale,
    });
  } catch (error) {
    console.error('updateReturnSale error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update return sale.',
    });
  }
};

export const deleteReturnSale = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid id.'});
    }

    const deleted = await ReturnSale.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({success: false, message: 'Return sale not found.'});
    }

    return res.status(200).json({
      success: true,
      message: 'Return sale deleted successfully.',
    });
  } catch (error) {
    console.error('deleteReturnSale error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete return sale.',
    });
  }
};

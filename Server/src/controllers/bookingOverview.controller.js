import mongoose from 'mongoose';
import SpaceBooking from '../models/spaceBooking.model.js';
import AllBooking from '../models/allBooking.model.js';
import Customer from '../models/customer.model.js';
import Wallet from '../models/wallet.model.js';
import {appendTransaction} from './wallet.controller.js';
import {persistableBucketFields, resolveTwoBuckets} from '../utils/walletBuckets.js';
import {
  getBookingPaymentRule,
  saveBookingPaymentRule,
} from '../services/bookingPaymentSettings.service.js';
import {refundableAmount} from '../utils/bookingPayment.js';

const REFUND_STATUSES = new Set(['Pending', 'Processing', 'Completed', 'Failed']);
const SORTS = new Set([
  'bookingDate',
  'bookingCode',
  'startTime',
  'endTime',
  'duration',
  'grandTotal',
  'paidAmount',
  'dueAmount',
  'customerName',
  'spaceName',
  'bookingStatus',
]);

const roundMoney = value => Math.round((Number(value) || 0) * 100) / 100;

const actorFrom = req => ({
  m_staff_id: req.staff?.m_staff_id || (req.staff?._id ? String(req.staff._id) : null),
  m_staff_name: req.staff?.fullName || null,
  m_staff_email: req.staff?.email || null,
});

const dateKey = value => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const durationLabel = doc => {
  const hours = Number(doc.durationHours) || 0;
  if (hours > 0) {
    const whole = Math.floor(hours);
    const minutes = Math.round((hours - whole) * 60);
    if (whole && minutes) return `${whole}h ${minutes}m`;
    if (whole) return `${whole}h`;
    return `${minutes}m`;
  }
  const minutesOf = value => {
    const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
  };
  const start = minutesOf(doc.startTime);
  const end = minutesOf(doc.endTime);
  if (start == null || end == null || end <= start) return '';
  const span = end - start;
  const whole = Math.floor(span / 60);
  const minutes = span % 60;
  if (whole && minutes) return `${whole}h ${minutes}m`;
  if (whole) return `${whole}h`;
  return `${minutes}m`;
};

const displayPaymentStatus = doc => {
  const refundStatus = String(doc.refund?.status || '');
  const refunded = Number(doc.refund?.amount) || 0;
  const paid = Number(doc.paidAmount) || 0;
  if (refundStatus === 'Completed') {
    return paid > 0 && refunded + 0.5 < paid ? 'Partially Refunded' : 'Refunded';
  }
  if (refundStatus === 'Pending' || refundStatus === 'Processing') return 'Refund Pending';
  const raw = String(doc.paymentStatus || '').trim().toLowerCase();
  const due = Number(doc.dueAmount) || 0;
  const total = Number(doc.grandTotal) || 0;
  if (raw === 'full' || (total > 0 && paid > 0 && due <= 1)) return 'Paid';
  if (raw === 'partial' || (paid > 0 && due > 1)) return 'Partially Paid';
  return 'Unpaid';
};

const mapBooking = (doc, source) => {
  const id = String(doc._id);
  const paid = roundMoney(doc.paidAmount);
  const total = roundMoney(doc.grandTotal);
  const due = roundMoney(doc.dueAmount ?? Math.max(0, total - paid));
  const code =
    doc.bookingCode ||
    doc.invoiceCode ||
    `${source === 'space' ? 'SB' : 'FB'}-${id.slice(-6).toUpperCase()}`;
  const refund = doc.refund || {};
  return {
    id,
    source,
    bookingCode: code,
    spaceName: doc.spaceName || '',
    customerName: doc.customerName || '',
    customerPhone: doc.customerPhone || '',
    bookingDate: dateKey(doc.bookingDate),
    startTime: doc.startTime || '',
    endTime: doc.endTime || '',
    duration: durationLabel(doc),
    grandTotal: total,
    paidAmount: paid,
    dueAmount: due,
    paymentStatus: displayPaymentStatus(doc),
    bookingStatus: doc.status || 'Upcoming',
    cancellation: doc.cancellation || null,
    cancellationHistory: Array.isArray(doc.cancellationHistory) ? doc.cancellationHistory : [],
    refund: {
      amount: roundMoney(refund.amount),
      refundableAmount: roundMoney(refund.refundableAmount),
      status: refund.status || '',
      refundedAt: refund.refundedAt || null,
      paymentReference: refund.paymentReference || '',
      method: refund.method || '',
      history: Array.isArray(refund.history) ? refund.history : [],
    },
    canCancel: doc.status !== 'Cancelled',
    canRefund:
      doc.status === 'Cancelled' &&
      Number(refund.refundableAmount) > 0 &&
      refund.status !== 'Completed',
  };
};

const inDateRange = (value, from, to) => {
  if (!from && !to) return true;
  if (!value) return false;
  if (from && value < from) return false;
  if (to && value > to) return false;
  return true;
};

const buildKpis = rows => {
  const pendingRefunds = rows.filter(row =>
    ['Pending', 'Processing'].includes(row.refund?.status),
  );
  return {
    totalBookings: rows.length,
    confirmedBookings: rows.filter(
      row => row.bookingStatus !== 'Draft' && row.bookingStatus !== 'Cancelled',
    ).length,
    pendingBookings: rows.filter(
      row =>
        row.bookingStatus !== 'Cancelled' &&
        (row.bookingStatus === 'Draft' ||
          row.paymentStatus === 'Unpaid' ||
          row.paymentStatus === 'Partially Paid'),
    ).length,
    cancelledBookings: rows.filter(row => row.bookingStatus === 'Cancelled').length,
    totalRevenue: roundMoney(
      rows
        .filter(row => row.bookingStatus !== 'Draft' && row.bookingStatus !== 'Cancelled')
        .reduce((sum, row) => sum + row.grandTotal, 0),
    ),
    pendingAmount: roundMoney(
      rows
        .filter(row => row.bookingStatus !== 'Draft' && row.bookingStatus !== 'Cancelled')
        .reduce((sum, row) => sum + (Number(row.dueAmount) || 0), 0),
    ),
    pendingRefundCount: pendingRefunds.length,
    pendingRefundAmount: roundMoney(
      pendingRefunds.reduce((sum, row) => sum + (Number(row.refund?.refundableAmount) || 0), 0),
    ),
  };
};

const modelFor = kind => (kind === 'space' ? SpaceBooking : AllBooking);

export const getBookingOverview = async (req, res) => {
  try {
    const [spaces, fulls] = await Promise.all([
      SpaceBooking.find().lean(),
      AllBooking.find().lean(),
    ]);
    const all = [
      ...spaces.map(doc => mapBooking(doc, 'space')),
      ...fulls.map(doc => mapBooking(doc, 'full')),
    ];
    const kpis = buildKpis(all);

    const search = String(req.query.search || '').trim().toLowerCase();
    const bookingStatus = String(req.query.bookingStatus || '').trim();
    const paymentStatus = String(req.query.paymentStatus || '').trim();
    const source = String(req.query.source || '').trim().toLowerCase();
    const from = String(req.query.from || '').trim();
    const to = String(req.query.to || '').trim();
    const spaceName = String(req.query.spaceName || '').trim().toLowerCase();
    const customerName = String(req.query.customerName || '').trim().toLowerCase();
    const sort = SORTS.has(String(req.query.sort || '')) ? String(req.query.sort) : 'bookingDate';
    const order = String(req.query.order || 'desc').toLowerCase() === 'asc' ? 1 : -1;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));

    const filtered = all.filter(row => {
      if (source === 'space' || source === 'full') {
        if (row.source !== source) return false;
      }
      if (bookingStatus && row.bookingStatus !== bookingStatus) return false;
      if (paymentStatus && row.paymentStatus !== paymentStatus) return false;
      if (spaceName && !row.spaceName.toLowerCase().includes(spaceName)) return false;
      if (customerName && !row.customerName.toLowerCase().includes(customerName)) return false;
      if (!inDateRange(row.bookingDate, from, to)) return false;
      if (search) {
        const hay = [row.bookingCode, row.spaceName, row.customerName, row.customerPhone, row.id]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    filtered.sort((left, right) => {
      const a = left[sort] ?? '';
      const b = right[sort] ?? '';
      if (typeof a === 'number' && typeof b === 'number') return (a - b) * order;
      return String(a).localeCompare(String(b)) * order;
    });

    const total = filtered.length;
    const start = (page - 1) * limit;
    return res.status(200).json({
      success: true,
      kpis,
      bookings: filtered.slice(start, start + limit),
      pagination: {
        page,
        limit,
        total,
        pages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (error) {
    console.error('getBookingOverview error:', error);
    return res.status(500).json({success: false, message: 'Could not load booking overview.'});
  }
};

export const getPaymentSettings = async (_req, res) => {
  try {
    const settings = await getBookingPaymentRule();
    return res.status(200).json({success: true, settings});
  } catch (error) {
    console.error('getPaymentSettings error:', error);
    return res.status(500).json({success: false, message: 'Could not load payment settings.'});
  }
};

export const updatePaymentSettings = async (req, res) => {
  try {
    const settings = await saveBookingPaymentRule(req.body || {}, actorFrom(req));
    return res.status(200).json({success: true, settings});
  } catch (error) {
    console.error('updatePaymentSettings error:', error);
    return res.status(500).json({success: false, message: 'Could not save payment settings.'});
  }
};

const loadBooking = async (kind, id) => {
  if (kind !== 'space' && kind !== 'full') return {error: 'Unknown booking type.', status: 400};
  if (!mongoose.Types.ObjectId.isValid(id)) return {error: 'Invalid booking id.', status: 400};
  const doc = await modelFor(kind).findById(id);
  if (!doc) return {error: 'Booking not found.', status: 404};
  return {doc};
};

export const cancelOverviewBooking = async (req, res) => {
  try {
    const kind = String(req.params.kind || '').trim();
    const loaded = await loadBooking(kind, req.params.id);
    if (loaded.error) return res.status(loaded.status).json({success: false, message: loaded.error});
    if (loaded.doc.status === 'Cancelled') {
      return res.status(400).json({
        success: false,
        message: 'This booking is already cancelled.',
      });
    }

    const reason = String(req.body?.reason || '').trim();
    if (!reason) {
      return res.status(400).json({success: false, message: 'A cancellation reason is required.'});
    }

    const rule = await getBookingPaymentRule();
    const paid = roundMoney(loaded.doc.paidAmount);
    const refundable = refundableAmount(paid, rule);
    const actor = actorFrom(req);
    const now = new Date();
    const entry = {reason, cancelledAt: now, cancelledBy: actor};
    const $set = {status: 'Cancelled', cancellation: entry};
    if (refundable > 0 && loaded.doc.refund?.status !== 'Completed') {
      $set['refund.refundableAmount'] = refundable;
      $set['refund.amount'] = refundable;
      $set['refund.status'] = 'Pending';
    }

    const updated = await modelFor(kind).findOneAndUpdate(
      {_id: loaded.doc._id, status: {$ne: 'Cancelled'}},
      {$set, $push: {cancellationHistory: entry}},
      {new: true},
    );
    if (!updated) {
      return res.status(409).json({
        success: false,
        message: 'This booking is already cancelled.',
      });
    }
    return res.status(200).json({
      success: true,
      booking: mapBooking(updated.toObject(), kind),
    });
  } catch (error) {
    console.error('cancelOverviewBooking error:', error);
    return res.status(500).json({success: false, message: 'Could not cancel the booking.'});
  }
};

const isWalletMethod = method => String(method || '').trim().toLowerCase() === 'wallet';

const findRefundCustomer = async doc => {
  const customerId = doc?.customerId;
  if (customerId && mongoose.Types.ObjectId.isValid(String(customerId))) {
    const byId = await Customer.findById(customerId);
    if (byId) return byId;
  }
  const phone = String(doc?.customerPhone || '').trim();
  const digits = phone.replace(/\D/g, '');
  const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
  if (!phone && !last10) return null;
  const phones = [...new Set([phone, digits, last10, last10 ? `+91${last10}` : '', last10 ? `91${last10}` : ''].filter(Boolean))];
  return Customer.findOne({
    $or: phones.flatMap(value => [{mobile: value}, {whatsappNumber: value}]),
  });
};

/** Credit a completed wallet refund once per booking. */
const creditBookingRefundToWallet = async (doc, amount, note, actor) => {
  const customer = await findRefundCustomer(doc);
  if (!customer) {
    const error = new Error('Customer not found for this wallet refund.');
    error.statusCode = 404;
    throw error;
  }

  const seed = resolveTwoBuckets(null, customer);
  let wallet = await Wallet.findOne({customerId: customer._id});
  if (!wallet) {
    wallet = await Wallet.create({
      customerId: customer._id,
      customerName: String(customer.name || doc.customerName || '').trim(),
      customerPhone: String(customer.mobile || doc.customerPhone || '').trim(),
      ...persistableBucketFields(seed),
      transactions: [],
    });
  }

  const referenceId = String(doc._id);
  const alreadyCredited = (wallet.transactions || []).some(
    tx =>
      String(tx.referenceId || '') === referenceId &&
      String(tx.referenceType || '') === 'booking-refund' &&
      String(tx.type || '').toLowerCase() === 'credit',
  );
  if (alreadyCredited) return;

  const bookingCode = doc.bookingCode || doc.invoiceCode || referenceId.slice(-6);
  await appendTransaction(wallet, {
    type: 'credit',
    amount,
    note: note || `Booking refund ${bookingCode}`,
    referenceType: 'booking-refund',
    referenceId,
    walletType: 'nonWithdrawable',
    createdBy: actor,
  });
};

export const updateOverviewRefund = async (req, res) => {
  try {
    const kind = String(req.params.kind || '').trim();
    const loaded = await loadBooking(kind, req.params.id);
    if (loaded.error) return res.status(loaded.status).json({success: false, message: loaded.error});
    if (loaded.doc.status !== 'Cancelled') {
      return res.status(400).json({
        success: false,
        message: 'Refunds can only be recorded for cancelled bookings.',
      });
    }
    if (loaded.doc.refund?.status === 'Completed') {
      return res.status(409).json({
        success: false,
        message: 'This refund has already been completed.',
      });
    }

    const refundable = roundMoney(loaded.doc.refund?.refundableAmount);
    if (refundable <= 0) {
      return res.status(400).json({
        success: false,
        message: 'This booking has no refundable amount.',
      });
    }

    const status = String(req.body?.status || '').trim();
    if (!REFUND_STATUSES.has(status)) {
      return res.status(400).json({success: false, message: 'Choose a valid refund status.'});
    }
    const amount = roundMoney(
      req.body?.amount === undefined || req.body?.amount === ''
        ? loaded.doc.refund?.amount || refundable
        : req.body.amount,
    );
    if (amount <= 0 || amount - refundable > 0.5) {
      return res.status(400).json({
        success: false,
        message: 'Refund amount cannot exceed the refundable amount.',
      });
    }
    const method = String(req.body?.method || loaded.doc.refund?.method || '').trim();
    const paymentReference = String(
      req.body?.paymentReference || loaded.doc.refund?.paymentReference || '',
    ).trim();
    const note = String(req.body?.note || '').trim();
    const actor = actorFrom(req);
    const now = new Date();

    if (isWalletMethod(method) && status !== 'Failed') {
      try {
        await creditBookingRefundToWallet(loaded.doc, amount, note, actor);
      } catch (error) {
        return res.status(error.statusCode || 400).json({
          success: false,
          message: error.message || 'Could not add the refund to the wallet.',
        });
      }
    }

    const updated = await modelFor(kind).findOneAndUpdate(
      {
        _id: loaded.doc._id,
        status: 'Cancelled',
        'refund.status': {$ne: 'Completed'},
      },
      {
        $set: {
          'refund.amount': amount,
          'refund.status': status,
          'refund.method': method,
          'refund.paymentReference': paymentReference,
          'refund.refundedAt': status === 'Completed' ? now : loaded.doc.refund?.refundedAt || null,
        },
        $push: {
          'refund.history': {
            status,
            amount,
            at: now,
            note,
            paymentReference,
            method,
            by: actor,
          },
        },
      },
      {new: true},
    );
    if (!updated) {
      return res.status(409).json({
        success: false,
        message: 'This refund has already been completed.',
      });
    }
    return res.status(200).json({
      success: true,
      booking: mapBooking(updated.toObject(), kind),
    });
  } catch (error) {
    console.error('updateOverviewRefund error:', error);
    return res.status(500).json({success: false, message: 'Could not update the refund.'});
  }
};

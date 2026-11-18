import mongoose from 'mongoose';
import SpaceBooking from '../models/spaceBooking.model.js';
import AllBooking from '../models/allBooking.model.js';
import Space from '../models/space.model.js';
import Invoice from '../models/invoice.model.js';
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

const bookedSpaceType = (doc, catalogue) => {
  const nameKey = String(doc.spaceName || '').trim().toLowerCase();
  const linked = catalogue?.byId?.get(String(doc.spaceId || ''));
  const named = catalogue?.byName?.get(nameKey) || [];
  const rows = named.length ? named : linked ? [linked] : [];
  const categories = rows
    .map(row => String(row.category || '').trim())
    .filter(Boolean);
  const specific = categories.find(category => category.toLowerCase() !== 'studio');
  const fromSpace = specific || categories[0] || '';
  const saved = String(doc.spaceCategory || '').trim();
  const kind = String(doc.spaceType || '').trim();
  const generic = value => !value || ['exclusive', 'coworking', 'space'].includes(value.toLowerCase());
  if (!generic(fromSpace)) return fromSpace;
  if (!generic(saved) && saved.toLowerCase() !== 'studio') return saved;
  if (!generic(kind)) return kind;
  return fromSpace || saved || 'Space';
};

const mapBooking = (doc, source, catalogue) => {
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
    durationHours: bookingHours(doc.startTime, doc.endTime, doc.durationHours),
    spaceType: bookedSpaceType(doc, catalogue),
    category: total > 0 ? 'Paid' : 'Free',
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

const DAY_OPEN = 6 * 60;
const DAY_CLOSE = 24 * 60;
const DAY_HOURS = 18;

const clockMinutes = value => {
  const raw = String(value || '').trim();
  if (raw === '24:00') return 24 * 60;
  const match = raw.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return Number.isFinite(minutes) ? minutes : null;
};

const bookingHours = (startTime, endTime, storedHours) => {
  const start = clockMinutes(startTime);
  const end = clockMinutes(endTime);
  if (start != null && end != null && end > start) {
    const from = Math.max(DAY_OPEN, start);
    const to = Math.min(DAY_CLOSE, end);
    if (to > from) return Math.round(((to - from) / 60) * 100) / 100;
    return 0;
  }
  const hours = Number(storedHours) || 0;
  return hours > 0 ? Math.round(Math.min(hours, DAY_HOURS) * 100) / 100 : 0;
};

const clipInterval = (startTime, endTime) => {
  const start = clockMinutes(startTime);
  const end = clockMinutes(endTime);
  if (start == null || end == null || end <= start) return null;
  const from = Math.max(DAY_OPEN, start);
  const to = Math.min(DAY_CLOSE, end);
  return to > from ? {start: from, end: to} : null;
};

const mergedHours = intervals => {
  const sorted = intervals.slice().sort((a, b) => a.start - b.start);
  let total = 0;
  let open = null;
  for (const interval of sorted) {
    if (!open || interval.start > open.end) {
      if (open) total += open.end - open.start;
      open = {...interval};
    } else {
      open.end = Math.max(open.end, interval.end);
    }
  }
  if (open) total += open.end - open.start;
  return Math.round((total / 60) * 100) / 100;
};

const eachDate = (from, to) => {
  if (!from || !to || to < from) return [];
  const [year, month, day] = from.split('-').map(Number);
  const cursor = new Date(year, month - 1, day);
  const [endYear, endMonth, endDay] = to.split('-').map(Number);
  const end = new Date(endYear, endMonth - 1, endDay);
  const dates = [];
  for (let guard = 0; guard < 400 && cursor <= end; guard += 1) {
    dates.push(dateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
};

const buildUtilization = async (rows, from, to) => {
  const active = rows.filter(
    row => row.bookingStatus !== 'Cancelled' && row.bookingStatus !== 'Draft',
  );
  const dated = active.map(row => row.bookingDate).filter(Boolean).sort();
  const rangeFrom = from || dated[0] || '';
  const rangeTo = to || dated[dated.length - 1] || rangeFrom;
  const dates = eachDate(rangeFrom, rangeTo);
  const spaces = await Space.find({status: {$ne: 'Maintenance'}}).select('name').lean();
  const catalogue = new Set(spaces.map(space => String(space.name || '').trim()).filter(Boolean));
  const spaceCount = Math.max(1, catalogue.size || new Set(active.map(row => row.spaceName).filter(Boolean)).size || 1);
  // One operating day is 18 hours. A week is 18 × 7, a month is 18 × the days in that range.
  const availableHours = dates.length * DAY_HOURS;
  const bySpaceDay = new Map();
  for (const row of active) {
    const interval = clipInterval(row.startTime, row.endTime);
    if (!interval || !row.bookingDate) continue;
    const key = `${row.spaceName || row.id}|${row.bookingDate}`;
    const list = bySpaceDay.get(key) || [];
    list.push(interval);
    bySpaceDay.set(key, list);
  }
  let utilizedHours = 0;
  for (const intervals of bySpaceDay.values()) utilizedHours += mergedHours(intervals);
  utilizedHours = Math.round(utilizedHours * 100) / 100;
  const paid = active.filter(row => row.category === 'Paid');
  const free = active.filter(row => row.category !== 'Paid');
  const sumHours = list => Math.round(list.reduce((sum, row) => sum + (Number(row.durationHours) || 0), 0) * 100) / 100;
  const paidHours = sumHours(paid);
  const freeHours = sumHours(free);
  const bookedHours = Math.round((paidHours + freeHours) * 100) / 100;
  const days = dates.map(date => {
    const dayRows = active.filter(row => row.bookingDate === date);
    return {
      date,
      paidHours: sumHours(dayRows.filter(row => row.category === 'Paid')),
      freeHours: sumHours(dayRows.filter(row => row.category !== 'Paid')),
      availableHours: DAY_HOURS,
      bookings: dayRows.length,
    };
  });
  const typeMap = new Map();
  for (const row of active) {
    const key = row.spaceType || 'Space';
    const current = typeMap.get(key) || {spaceType: key, bookings: 0, hours: 0, paidHours: 0, freeHours: 0, spaces: []};
    const hours = Number(row.durationHours) || 0;
    current.bookings += 1;
    current.hours = Math.round((current.hours + hours) * 100) / 100;
    if (row.spaceName && !current.spaces.includes(row.spaceName)) current.spaces.push(row.spaceName);
    if (row.category === 'Paid') current.paidHours = Math.round((current.paidHours + hours) * 100) / 100;
    else current.freeHours = Math.round((current.freeHours + hours) * 100) / 100;
    typeMap.set(key, current);
  }
  const spaceTypes = [...typeMap.values()]
    .map(item => ({
      ...item,
      share: bookedHours > 0 ? Math.round((item.hours / bookedHours) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.hours - a.hours);
  return {
    from: rangeFrom,
    to: rangeTo,
    dayHours: DAY_HOURS,
    days: dates.length,
    spaceCount,
    availableHours,
    bookedHours,
    utilizedHours,
    utilization: availableHours > 0 ? Math.round((bookedHours / availableHours) * 1000) / 10 : 0,
    paidHours,
    paidBookings: paid.length,
    freeHours,
    freeBookings: free.length,
    daysSeries: days,
    spaceTypes,
    rows: active.map(row => ({
      id: row.id,
      bookingCode: row.bookingCode,
      customerName: row.customerName,
      spaceName: row.spaceName,
      spaceType: row.spaceType,
      bookingDate: row.bookingDate,
      startTime: row.startTime,
      endTime: row.endTime,
      durationHours: row.durationHours,
      category: row.category,
      paymentStatus: row.paymentStatus,
      grandTotal: row.grandTotal,
    })),
  };
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

/** The invoice is the billed total. A saved booking total can still be gross or double-discounted. */
const applyInvoiceTotals = async bookings => {
  const list = Array.isArray(bookings) ? bookings : [];
  const ids = [];
  const codes = [];
  for (const booking of list) {
    if (booking.invoiceId && mongoose.Types.ObjectId.isValid(String(booking.invoiceId))) {
      ids.push(booking.invoiceId);
    }
    const code = String(booking.invoiceCode || '').trim();
    if (code) codes.push(code);
  }
  if (!ids.length && !codes.length) return list;
  const invoices = await Invoice.find({
    $or: [
      ...(ids.length ? [{_id: {$in: ids}}] : []),
      ...(codes.length ? [{invoiceCode: {$in: codes}}] : []),
    ],
  })
    .select('invoiceCode grandTotal pendingAmount paymentBreakdown')
    .lean();
  const byId = new Map(invoices.map(invoice => [String(invoice._id), invoice]));
  const byCode = new Map(invoices.map(invoice => [String(invoice.invoiceCode || ''), invoice]));
  for (const booking of list) {
    if (String(booking.status || '') === 'Draft') continue;
    const invoice =
      byId.get(String(booking.invoiceId || '')) ||
      byCode.get(String(booking.invoiceCode || ''));
    if (!invoice || !(Number(invoice.grandTotal) > 0)) continue;
    const total = roundMoney(invoice.grandTotal);
    const paid = roundMoney(invoice.paymentBreakdown?.paidAmount);
    const dueRaw = roundMoney(
      invoice.pendingAmount ?? invoice.paymentBreakdown?.dueAmount ?? 0,
    );
    booking.grandTotal = total;
    booking.paidAmount = dueRaw < 1 ? total : paid;
    booking.dueAmount = dueRaw < 1 ? 0 : dueRaw;
  }
  return list;
};

export const getBookingOverview = async (req, res) => {
  try {
    const [spaceBookings, fulls, catalogueRows] = await Promise.all([
      SpaceBooking.find().lean(),
      AllBooking.find().lean(),
      Space.find().select('name category spaceType').lean(),
    ]);
    await applyInvoiceTotals(spaceBookings);
    const byId = new Map(catalogueRows.map(row => [String(row._id), row]));
    const byName = new Map();
    for (const row of catalogueRows) {
      const key = String(row.name || '').trim().toLowerCase();
      if (!key) continue;
      const list = byName.get(key) || [];
      list.push(row);
      byName.set(key, list);
    }
    const catalogue = {byId, byName};
    const all = [
      ...spaceBookings.map(doc => mapBooking(doc, 'space', catalogue)),
      ...fulls.map(doc => mapBooking(doc, 'full', catalogue)),
    ];
    const kpis = buildKpis(all);
    const rangeFrom = String(req.query.from || '').trim();
    const rangeTo = String(req.query.to || '').trim();
    const utilization = await buildUtilization(
      all.filter(row => inDateRange(row.bookingDate, rangeFrom, rangeTo)),
      rangeFrom,
      rangeTo,
    );

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
      utilization,
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

import mongoose from 'mongoose';
import SpaceBooking from '../models/spaceBooking.model.js';
import Space from '../models/space.model.js';
import Customer from '../models/customer.model.js';
import Membership from '../models/membership.model.js';
import Wallet from '../models/wallet.model.js';
import {isCustomerMembershipExpired} from '../services/membershipEligibility.service.js';
import {appendTransaction} from './wallet.controller.js';
import Invoice from '../models/invoice.model.js';
import {purgeInvoiceById} from './invoice.controller.js';
import {
  BOOKING_TIMEZONE,
  BookingValidationError,
  buildBookingIntervals,
  findBusyIntervals,
  getAvailabilityRangeError,
  intervalKey,
  nowInBusinessTz,
  resolveSpaceGroup,
  validateAndPersistSchedule,
} from '../services/spaceBookingAvailability.service.js';
import {bookingPaymentError} from '../utils/bookingPayment.js';
import {applyOfferToBookingPayload} from './spaceOffer.controller.js';
import {quoteBookingOffer} from '../services/spaceOffer.service.js';
import SpaceOffer from '../models/spaceOffer.model.js';
import {sendSpaceBookingQuotationWhatsApp} from '../modules/customer/services/whatsapp.service.js';
import {getBookingPaymentRule} from '../services/bookingPaymentSettings.service.js';

const ALLOWED_STATUS = new Set([
  'Upcoming',
  'Ongoing',
  'Expired',
  'Cancelled',
  'Draft',
]);

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const normalizeStatus = value => {
  const status = String(value || 'Upcoming').trim();
  return ALLOWED_STATUS.has(status) ? status : 'Upcoming';
};

/**
 * Confirming a booking (not a draft or a notes-only edit) must meet the
 * saved partial-payment minimum. Full payment is the maximum and is not
 * limited by that minimum. `requestBody` limits the check to requests
 * that actually send payment fields.
 */
const bookingPaymentRejection = async (record, requestBody) => {
  const status = String(record?.status || '').trim();
  if (status === 'Draft' || status === 'Cancelled') return '';
  if (requestBody) {
    const sentPayment =
      requestBody.paymentStatus !== undefined || requestBody.paidAmount !== undefined;
    if (!sentPayment) return '';
  }
  const paymentStatus = String(record?.paymentStatus || '').trim().toLowerCase();
  if (!paymentStatus) return '';
  const rule = await getBookingPaymentRule();
  return bookingPaymentError({
    total: record?.grandTotal,
    paid: record?.paidAmount,
    paymentStatus,
    rule,
  });
};

export const computeBookingStatus = (
  bookingDate,
  startTime,
  endTime,
  currentStatus,
  now = new Date(),
) => {
  if (currentStatus === 'Cancelled') {
    return 'Cancelled';
  }
  if (currentStatus === 'Draft') {
    return 'Draft';
  }

  if (!bookingDate || !startTime || !endTime) {
    return currentStatus || 'Upcoming';
  }

  let year, month, day;
  if (typeof bookingDate === 'string') {
    const m = bookingDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      year = Number(m[1]);
      month = Number(m[2]) - 1;
      day = Number(m[3]);
    } else {
      const d = new Date(bookingDate);
      if (Number.isNaN(d.getTime())) return currentStatus || 'Upcoming';
      year = d.getFullYear();
      month = d.getMonth();
      day = d.getDate();
    }
  } else if (bookingDate instanceof Date) {
    if (Number.isNaN(bookingDate.getTime())) return currentStatus || 'Upcoming';
    year = bookingDate.getFullYear();
    month = bookingDate.getMonth();
    day = bookingDate.getDate();
  } else {
    return currentStatus || 'Upcoming';
  }

  const [sH, sM] = String(startTime).split(':').map(Number);
  const [eH, eM] = String(endTime).split(':').map(Number);
  if (
    Number.isNaN(sH) ||
    Number.isNaN(sM) ||
    Number.isNaN(eH) ||
    Number.isNaN(eM)
  ) {
    return currentStatus || 'Upcoming';
  }

  const start = new Date(year, month, day, sH, sM, 0, 0);
  const end = new Date(year, month, day, eH, eM, 0, 0);
  const nowMs = now.getTime();

  if (nowMs < start.getTime()) return 'Upcoming';
  if (nowMs < end.getTime()) return 'Ongoing';
  return 'Expired';
};

export const syncBookingStatuses = async () => {
  try {
    const now = new Date();
    const activeBookings = await SpaceBooking.find({
      status: { $in: ['Upcoming', 'Ongoing'] },
    }).select('_id bookingDate startTime endTime status');

    if (!activeBookings || activeBookings.length === 0) return;

    const bulkOps = [];
    for (const b of activeBookings) {
      const newStatus = computeBookingStatus(
        b.bookingDate,
        b.startTime,
        b.endTime,
        b.status,
        now,
      );
      if (newStatus !== b.status) {
        bulkOps.push({
          updateOne: {
            filter: { _id: b._id },
            update: { $set: { status: newStatus } },
          },
        });
      }
    }

    if (bulkOps.length > 0) {
      await SpaceBooking.bulkWrite(bulkOps);
    }
  } catch (err) {
    console.error('syncBookingStatuses error:', err);
  }
};

const toMinutes = timeStr => {
  const raw = String(timeStr || '').trim();
  if (raw === '24:00') return 24 * 60;
  const m = raw.match(TIME_RE);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};

const isEndTime = value => String(value || '').trim() === '24:00' || TIME_RE.test(String(value || '').trim());

const formatTimeDisplay = timeStr => {
  const mins = toMinutes(timeStr);
  if (mins == null) return String(timeStr || '');
  const h = Math.floor(mins / 60);
  if (h >= 24) return '12:00 AM';
  const m = mins % 60;
  const period = h >= 12 ? 'PM' : 'AM';
  const displayH = h % 12 === 0 ? 12 : h % 12;
  return `${displayH}:${String(m).padStart(2, '0')} ${period}`;
};

const moneyValue = value => Math.round((Number(value) || 0) * 100) / 100;

/** Booking details follow the linked invoice after a due payment is received. */
const applyLinkedInvoicePayments = async bookings => {
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
    .select('invoiceCode grandTotal pendingAmount paymentBreakdown paymentStatus mode')
    .lean();
  const byId = new Map(invoices.map(invoice => [String(invoice._id), invoice]));
  const byCode = new Map(invoices.map(invoice => [String(invoice.invoiceCode || ''), invoice]));
  for (const booking of list) {
    if (String(booking.status || '') === 'Draft') continue;
    const invoice =
      byId.get(String(booking.invoiceId || '')) ||
      byCode.get(String(booking.invoiceCode || ''));
    if (!invoice) continue;
    const paid = moneyValue(invoice.paymentBreakdown?.paidAmount);
    const dueRaw = moneyValue(
      invoice.pendingAmount ?? invoice.paymentBreakdown?.dueAmount ?? 0,
    );
    const due = dueRaw < 1 ? 0 : dueRaw;
    const total = moneyValue(invoice.grandTotal || booking.grandTotal);
    booking.paidAmount = due === 0 ? total : paid;
    booking.dueAmount = due;
    booking.paymentStatus = due === 0 ? 'full' : paid > 0 ? 'partial' : booking.paymentStatus || '';
    if (total > 0) booking.grandTotal = total;
    if (invoice.mode) booking.paymentMode = invoice.mode;
  }
  return list;
};

const serializeBooking = doc => {
  const plain =
    typeof doc?.toObject === 'function' ? doc.toObject() : {...doc};
  const space =
    plain.spaceId && typeof plain.spaceId === 'object' && plain.spaceId._id
      ? plain.spaceId
      : null;

  return {
    ...plain,
    id: String(plain._id),
    spaceId: space ? String(space._id) : String(plain.spaceId || ''),
    spaceName: space?.name || plain.spaceName || '',
    spaceCode: space?.spaceCode || plain.spaceCode || '',
    spaceType: space?.spaceType || plain.spaceType || '',
    spaceCategory: space?.category || plain.spaceCategory || '',
    spaceDay: space?.day || plain.spaceDay || '',
    space: space
      ? {
          _id: String(space._id),
          name: space.name,
          spaceCode: space.spaceCode || '',
          spaceType: space.spaceType || '',
          category: space.category,
          day: space.day,
          price: space.price,
          capacity: space.capacity,
          status: space.status,
          imageUrl: space.imageUrl || null,
        }
      : null,
    bookingTime: `${formatTimeDisplay(plain.startTime)} - ${formatTimeDisplay(plain.endTime)}`,
    ...settleRoundOff(plain),
  };
};

/** A leftover under ₹1 is the bill round-off, not an open due. */
const settleRoundOff = plain => {
  if (String(plain.status || '') === 'Draft') {
    const total = money(plain.grandTotal || plain.lineTotal || plain.summarySnapshot?.grandTotal || 0);
    return {
      paidAmount: 0,
      dueAmount: total,
      paymentStatus: '',
    };
  }
  const total = money(plain.grandTotal || plain.lineTotal || 0);
  const paid = money(plain.paidAmount || 0);
  const storedDue = money(plain.dueAmount || 0);
  const remaining = storedDue > 0 ? storedDue : money(Math.max(0, total - paid));
  if (!(remaining < 1) || !(paid > 0 || remaining === 0)) return {};
  return {
    dueAmount: 0,
    paidAmount: total > 0 ? total : paid,
    paymentStatus: 'full',
  };
};

const buildPayload = (body = {}, {partial = false} = {}) => {
  const payload = {};
  const errors = [];

  if (!partial || body.customerName !== undefined) {
    const customerName = String(body.customerName ?? '').trim();
    if (!customerName) errors.push('Customer name is required.');
    else payload.customerName = customerName;
  }

  if (!partial || body.customerPhone !== undefined) {
    const customerPhone = String(body.customerPhone ?? '')
      .trim()
      .replace(/\D/g, '');
    if (!customerPhone) errors.push('Customer phone is required.');
    else if (customerPhone.length < 10)
      errors.push('Please enter a valid phone number.');
    else payload.customerPhone = customerPhone;
  }

  if (!partial || body.customerEmail !== undefined) {
    payload.customerEmail = String(body.customerEmail ?? '')
      .trim()
      .toLowerCase();
  }

  if (!partial || body.spaceId !== undefined) {
    const spaceId = String(body.spaceId ?? '').trim();
    if (!spaceId || !mongoose.Types.ObjectId.isValid(spaceId)) {
      errors.push('A valid space is required.');
    } else {
      payload.spaceId = spaceId;
    }
  }

  if (!partial || body.bookingDate !== undefined) {
    const raw = body.bookingDate;
    const d = raw ? new Date(raw) : null;
    if (!d || Number.isNaN(d.getTime())) {
      errors.push('Booking date is required.');
    } else {
      payload.bookingDate = d;
    }
  }

  if (!partial || body.startTime !== undefined) {
    const startTime = String(body.startTime ?? '').trim();
    if (!TIME_RE.test(startTime)) errors.push('Valid start time is required (HH:mm).');
    else payload.startTime = startTime;
  }

  if (!partial || body.endTime !== undefined) {
    const endTime = String(body.endTime ?? '').trim();
    if (!isEndTime(endTime)) errors.push('Valid end time is required (HH:mm).');
    else payload.endTime = endTime;
  }

  if (payload.startTime && payload.endTime) {
    const a = toMinutes(payload.startTime);
    const b = toMinutes(payload.endTime);
    if (a != null && b != null && b <= a) {
      errors.push('End time must be after start time.');
    }
  }

  if (!partial || body.status !== undefined) {
    payload.status = normalizeStatus(body.status);
  }

  if (!partial || body.notes !== undefined) {
    payload.notes = String(body.notes ?? '').trim();
  }

  if (!partial || body.invoiceId !== undefined) {
    const invoiceId = String(body.invoiceId ?? '').trim();
    if (invoiceId && mongoose.Types.ObjectId.isValid(invoiceId)) {
      payload.invoiceId = invoiceId;
    } else if (!invoiceId) {
      payload.invoiceId = null;
    }
  }

  if (!partial || body.invoiceCode !== undefined) {
    payload.invoiceCode = String(body.invoiceCode ?? '').trim();
  }

  if (!partial || body.grandTotal !== undefined) {
    const n = Number(body.grandTotal);
    if (!Number.isNaN(n) && n >= 0) payload.grandTotal = n;
  }

  if (!partial || body.paidAmount !== undefined) {
    const n = Number(body.paidAmount);
    if (!Number.isNaN(n) && n >= 0) payload.paidAmount = n;
  }

  if (!partial || body.dueAmount !== undefined) {
    const n = Number(body.dueAmount);
    if (!Number.isNaN(n) && n >= 0) payload.dueAmount = n;
  }

  if (!partial || body.paymentStatus !== undefined) {
    const ps = String(body.paymentStatus ?? '').trim().toLowerCase();
    if (ps === 'full' || ps === 'partial') payload.paymentStatus = ps;
    else if (!ps) payload.paymentStatus = '';
  }

  if (!partial || body.paymentMode !== undefined) {
    payload.paymentMode = String(body.paymentMode ?? '').trim();
  }

  if (!partial || body.spaceType !== undefined) {
    payload.spaceType = String(body.spaceType ?? '').trim();
  }
  if (!partial || body.spaceCode !== undefined) {
    payload.spaceCode = String(body.spaceCode ?? '').trim();
  }
  if (!partial || body.spaceCategory !== undefined) {
    payload.spaceCategory = String(body.spaceCategory ?? '').trim();
  }
  if (!partial || body.spaceDay !== undefined) {
    payload.spaceDay = String(body.spaceDay ?? '').trim();
  }
  if (!partial || body.unitPrice !== undefined) {
    const n = Number(body.unitPrice);
    if (!Number.isNaN(n) && n >= 0) payload.unitPrice = n;
  }
  if (!partial || body.durationHours !== undefined) {
    const n = Number(body.durationHours);
    if (!Number.isNaN(n) && n >= 0) payload.durationHours = n;
  }
  if (!partial || body.lineTotal !== undefined) {
    const n = Number(body.lineTotal);
    if (!Number.isNaN(n) && n >= 0) payload.lineTotal = n;
  }
  if (!partial || body.spaceQty !== undefined) {
    const n = Number(body.spaceQty);
    if (!Number.isNaN(n) && n >= 1) payload.spaceQty = n;
  }
  if (!partial || body.dateMode !== undefined) {
    payload.dateMode = String(body.dateMode || 'single');
  }
  if (!partial || body.multiDateSlots !== undefined) {
    payload.multiDateSlots = Array.isArray(body.multiDateSlots)
      ? body.multiDateSlots
      : [];
  }
  if (!partial || body.durationCount !== undefined) {
    const n = Number(body.durationCount);
    if (!Number.isNaN(n) && n >= 1) payload.durationCount = n;
  }
  if (!partial || body.durationUnit !== undefined) {
    payload.durationUnit = String(body.durationUnit || 'day');
  }
  if (!partial || body.packageMultiplier !== undefined) {
    const n = Number(body.packageMultiplier);
    if (!Number.isNaN(n) && n >= 1) payload.packageMultiplier = n;
  }
  if (!partial || body.coworkingStartDate !== undefined) {
    payload.coworkingStartDate = String(body.coworkingStartDate || '');
  }
  if (!partial || body.coworkingEndDate !== undefined) {
    payload.coworkingEndDate = String(body.coworkingEndDate || '');
  }
  if (!partial || body.subTotal !== undefined) {
    const n = Number(body.subTotal);
    if (!Number.isNaN(n) && n >= 0) payload.subTotal = n;
  }
  if (!partial || body.discountAmount !== undefined) {
    const n = Number(body.discountAmount);
    if (!Number.isNaN(n) && n >= 0) payload.discountAmount = n;
  }
  if (!partial || body.offerDiscount !== undefined) {
    const n = Number(body.offerDiscount);
    if (!Number.isNaN(n) && n >= 0) payload.offerDiscount = n;
  }
  if (!partial || body.cashbackAmount !== undefined) {
    const n = Number(body.cashbackAmount);
    if (!Number.isNaN(n) && n >= 0) payload.cashbackAmount = n;
  }
  if (!partial || body.selectedServices !== undefined) {
    payload.selectedServices = Array.isArray(body.selectedServices)
      ? body.selectedServices
      : [];
  }
  if (!partial || body.summarySnapshot !== undefined) {
    payload.summarySnapshot = body.summarySnapshot || null;
  }

  return {payload, errors};
};

const resolveSpaceSnapshot = async spaceId => {
  const space = await Space.findById(spaceId)
    .select('name category day price capacity status spaceType spaceCode imageUrl')
    .lean();
  return space;
};

const isReservingStatus = status => status !== 'Cancelled' && status !== 'Draft';

const sendBookingValidationError = (res, error) =>
  res.status(error.status).json({
    success: false,
    code: error.code,
    message: error.message,
    ...error.details,
  });

export const getSpaceBookingAvailability = async (req, res) => {
  try {
    const {spaceId, from, excludeId} = req.query;
    const fromKey = String(from || '').trim();
    const toKey = String(req.query.to || from || '').trim();

    const rangeError = getAvailabilityRangeError(fromKey, toKey);
    if (rangeError) {
      return res.status(400).json({success: false, message: rangeError});
    }

    const group = await resolveSpaceGroup(spaceId);
    if (!group) {
      return res.status(400).json({
        success: false,
        message: 'Selected space was not found.',
      });
    }

    const now = nowInBusinessTz();
    const busy = group.conflictScoped
      ? await findBusyIntervals({
          spaceIds: group.spaceIds,
          fromKey,
          toKey,
          excludeId: excludeId ? String(excludeId) : null,
        })
      : [];

    return res.status(200).json({
      success: true,
      timezone: BOOKING_TIMEZONE,
      today: now.dateKey,
      nowMinutes: now.minutes,
      conflictScoped: group.conflictScoped,
      from: fromKey,
      to: toKey,
      busy: busy.map(({date, startTime, endTime, bookingId, status}) => ({
        date,
        startTime,
        endTime,
        bookingId,
        status,
      })),
    });
  } catch (error) {
    console.error('getSpaceBookingAvailability error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to check space availability.',
    });
  }
};

/** Public catalogue view: occupied times only, no booking ids or customer data. */
export const getCustomerSpaceAvailability = async (req, res) => {
  try {
    const {spaceId, from} = req.query;
    const fromKey = String(from || '').trim();
    const toKey = String(req.query.to || from || '').trim();

    const rangeError = getAvailabilityRangeError(fromKey, toKey);
    if (rangeError) {
      return res.status(400).json({success: false, message: rangeError});
    }

    const group = await resolveSpaceGroup(spaceId);
    if (!group) {
      return res.status(400).json({
        success: false,
        message: 'Selected space was not found.',
      });
    }

    const now = nowInBusinessTz();
    const busy = await findBusyIntervals({
      spaceIds: group.spaceIds,
      fromKey,
      toKey,
    });

    return res.status(200).json({
      success: true,
      timezone: BOOKING_TIMEZONE,
      today: now.dateKey,
      nowMinutes: now.minutes,
      from: fromKey,
      to: toKey,
      busy: busy.map(({date, startTime, endTime}) => ({
        date,
        startTime,
        endTime,
      })),
    });
  } catch (error) {
    console.error('getCustomerSpaceAvailability error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to check space availability.',
    });
  }
};

export const createSpaceBooking = async (req, res) => {
  try {
    const {payload, errors} = buildPayload(req.body);
    if (errors.length) {
      return res.status(400).json({success: false, message: errors[0], errors});
    }

    const space = await resolveSpaceSnapshot(payload.spaceId);
    if (!space) {
      return res.status(400).json({
        success: false,
        message: 'Selected space was not found.',
      });
    }

    // Automatically compute status from date & time unless explicitly Cancelled or Draft
    if (payload.status !== 'Cancelled' && payload.status !== 'Draft') {
      payload.status = computeBookingStatus(
        payload.bookingDate,
        payload.startTime,
        payload.endTime,
        payload.status,
      );
    }

    const priceError = await enforceCatalogueSpacePrice(payload);
    if (priceError) {
      return res.status(400).json({success: false, message: priceError});
    }

    await applyOfferToBookingPayload(payload);
    const paymentError = await bookingPaymentRejection(payload);
    if (paymentError) {
      return res.status(400).json({success: false, message: paymentError});
    }

    const staffFromReq = {
      m_staff_id: req.user?.userId ?? null,
      m_staff_name: req.user?.name ?? null,
      m_staff_email: req.user?.email ?? null,
    };

    const persist = () =>
      SpaceBooking.create({
        ...payload,
        spaceName: space.name,
        spaceType: payload.spaceType || space.spaceType || '',
        spaceCode: payload.spaceCode || space.spaceCode || '',
        spaceCategory: payload.spaceCategory || space.category || '',
        spaceDay: payload.spaceDay || space.day || '',
        unitPrice: payload.unitPrice !== undefined ? payload.unitPrice : space.price,
        createdBy: staffFromReq,
      });

    let booking;
    if (isReservingStatus(payload.status)) {
      const {intervals, errors: scheduleErrors} = buildBookingIntervals(payload);
      if (scheduleErrors.length || intervals.length === 0) {
        return res.status(400).json({
          success: false,
          message: scheduleErrors[0] || 'A valid booking date and time are required.',
          errors: scheduleErrors,
        });
      }
      const group = await resolveSpaceGroup(payload.spaceId);
      booking = await validateAndPersistSchedule({group, intervals, persist});
    } else {
      booking = await persist();
    }

    const populated = await SpaceBooking.findById(booking._id).populate(
      'spaceId',
      'name category day price capacity status spaceType spaceCode imageUrl',
    );

    return res.status(201).json({
      success: true,
      message: 'Space booking created successfully.',
      booking: serializeBooking(populated),
    });
  } catch (error) {
    if (error instanceof BookingValidationError) {
      return sendBookingValidationError(res, error);
    }
    console.error('createSpaceBooking error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to create space booking.',
    });
  }
};

export const getSpaceBookings = async (req, res) => {
  try {
    // Automatically synchronize upcoming/ongoing/expired statuses based on current time
    await syncBookingStatuses();

    const {search = '', status, spaceId, fromDate, toDate} = req.query;
    const query = {};

    if (status && String(status).trim() && String(status) !== 'All') {
      query.status = normalizeStatus(status);
    }
    if (spaceId && mongoose.Types.ObjectId.isValid(String(spaceId))) {
      query.spaceId = String(spaceId);
    }
    if (fromDate || toDate) {
      query.bookingDate = {};
      if (fromDate) query.bookingDate.$gte = new Date(fromDate);
      if (toDate) {
        const end = new Date(toDate);
        end.setHours(23, 59, 59, 999);
        query.bookingDate.$lte = end;
      }
    }

    const s = String(search).trim();
    if (s) {
      query.$or = [
        {customerName: {$regex: s, $options: 'i'}},
        {customerPhone: {$regex: s, $options: 'i'}},
        {customerEmail: {$regex: s, $options: 'i'}},
        {spaceName: {$regex: s, $options: 'i'}},
        {notes: {$regex: s, $options: 'i'}},
      ];
    }

    const bookings = await applyLinkedInvoicePayments(
      await SpaceBooking.find(query)
      .populate(
        'spaceId',
        'name category day price capacity status spaceType spaceCode imageUrl',
      )
      .sort({bookingDate: -1, startTime: 1, createdAt: -1})
      .lean(),
    );
      const totalGrandTotal = bookings.reduce(
      (sum, booking) => sum + (Number(booking.grandTotal) || 0),
      0
    );

    return res.status(200).json({
      success: true,
      message: 'Space bookings fetched successfully.',
      bookings: bookings.map(serializeBooking),
       totalGrandTotal: Math.round(totalGrandTotal * 100) / 100,
    });
  } catch (error) {
    console.error('getSpaceBookings error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch space bookings.',
    });
  }
};

export const getSpaceBookingById = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid booking id.',
      });
    }

    const [booking] = await applyLinkedInvoicePayments([
      await SpaceBooking.findById(id)
      .populate(
        'spaceId',
        'name category day price capacity status spaceType spaceCode imageUrl',
      )
      .lean(),
    ].filter(Boolean));

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Space booking not found.',
      });
    }

    // Keep status up to date with date & time if not Cancelled
    const newStatus = computeBookingStatus(
      booking.bookingDate,
      booking.startTime,
      booking.endTime,
      booking.status,
    );
    if (newStatus !== booking.status) {
      await SpaceBooking.findByIdAndUpdate(booking._id, { status: newStatus });
      booking.status = newStatus;
    }

    return res.status(200).json({
      success: true,
      message: 'Space booking fetched successfully.',
      booking: serializeBooking(booking),
    });
  } catch (error) {
    console.error('getSpaceBookingById error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch space booking.',
    });
  }
};

export const updateSpaceBooking = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid booking id.',
      });
    }

    const existing = await SpaceBooking.findById(id);
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'Space booking not found.',
      });
    }

    const {payload, errors} = buildPayload(req.body, {partial: true});
    if (errors.length) {
      return res.status(400).json({success: false, message: errors[0], errors});
    }

    // Validate time order when either side changes
    const nextStart = payload.startTime ?? existing.startTime;
    const nextEnd = payload.endTime ?? existing.endTime;
    const a = toMinutes(nextStart);
    const b = toMinutes(nextEnd);
    if (a != null && b != null && b <= a) {
      return res.status(400).json({
        success: false,
        message: 'End time must be after start time.',
      });
    }

    if (payload.spaceId) {
      const space = await resolveSpaceSnapshot(payload.spaceId);
      if (!space) {
        return res.status(400).json({
          success: false,
          message: 'Selected space was not found.',
        });
      }
      payload.spaceName = space.name;
    }

    // Automatically recalculate status from updated date & time unless explicitly Cancelled or Draft
    const targetStatus = payload.status !== undefined ? payload.status : existing.status;
    if (targetStatus !== 'Cancelled' && targetStatus !== 'Draft') {
      const nextDate = payload.bookingDate ?? existing.bookingDate;
      payload.status = computeBookingStatus(
        nextDate,
        nextStart,
        nextEnd,
        targetStatus,
      );
    }

    const pricedPayload = {
      ...existing.toObject(),
      ...payload,
      spaceId: payload.spaceId || existing.spaceId,
      bookingDate: payload.bookingDate || existing.bookingDate,
      startTime: payload.startTime || existing.startTime,
      endTime: payload.endTime || existing.endTime,
      dateMode: payload.dateMode || existing.dateMode,
      multiDateSlots: payload.multiDateSlots || existing.multiDateSlots,
      summarySnapshot: payload.summarySnapshot || existing.summarySnapshot,
      spaceQty: payload.spaceQty ?? existing.spaceQty,
      durationHours: payload.durationHours ?? existing.durationHours,
      unitPrice: payload.unitPrice ?? existing.unitPrice,
      lineTotal: payload.lineTotal ?? existing.lineTotal,
      grandTotal: payload.grandTotal ?? existing.grandTotal,
    };
    const priceError = await enforceCatalogueSpacePrice(pricedPayload);
    if (priceError) {
      return res.status(400).json({success: false, message: priceError});
    }
    payload.unitPrice = pricedPayload.unitPrice;
    payload.spaceDay = pricedPayload.spaceDay;
    payload.spaceId = pricedPayload.spaceId;
    payload.spaceName = pricedPayload.spaceName;
    payload.spaceCode = pricedPayload.spaceCode;
    if (pricedPayload.lineTotal != null) payload.lineTotal = pricedPayload.lineTotal;
    if (pricedPayload.grandTotal != null) payload.grandTotal = pricedPayload.grandTotal;
    if (pricedPayload.summarySnapshot) payload.summarySnapshot = pricedPayload.summarySnapshot;

    await applyOfferToBookingPayload(payload, existing);
    const paymentError = await bookingPaymentRejection(
      {
        status: payload.status ?? existing.status,
        paymentStatus:
          payload.paymentStatus !== undefined
            ? payload.paymentStatus
            : existing.paymentStatus,
        grandTotal:
          payload.grandTotal !== undefined ? payload.grandTotal : existing.grandTotal,
        paidAmount:
          payload.paidAmount !== undefined ? payload.paidAmount : existing.paidAmount,
      },
      req.body,
    );
    if (paymentError) {
      return res.status(400).json({success: false, message: paymentError});
    }

    const persist = async () => {
      Object.assign(existing, payload);
      await existing.save();
    };

    if (isReservingStatus(targetStatus)) {
      const previous = existing.toObject();
      const next = {...previous, ...payload};
      const {intervals, errors: scheduleErrors} = buildBookingIntervals(next);
      if (scheduleErrors.length || intervals.length === 0) {
        return res.status(400).json({
          success: false,
          message: scheduleErrors[0] || 'A valid booking date and time are required.',
          errors: scheduleErrors,
        });
      }

      const group = await resolveSpaceGroup(next.spaceId);
      if (!group) {
        return res.status(400).json({
          success: false,
          message: 'Selected space was not found.',
        });
      }
      const previousGroup =
        String(previous.spaceId) === String(next.spaceId)
          ? group
          : await resolveSpaceGroup(previous.spaceId);

      const wasReserving = isReservingStatus(existing.status);
      const sameGroup = previousGroup?.lockKey === group.lockKey;
      const previousKeys = new Set(
        buildBookingIntervals(previous).intervals.map(intervalKey),
      );
      const checkIntervals =
        wasReserving && sameGroup
          ? intervals.filter(iv => !previousKeys.has(intervalKey(iv)))
          : intervals;

      await validateAndPersistSchedule({
        group,
        intervals,
        checkIntervals,
        excludeId: existing._id,
        persist,
      });
    } else {
      await persist();
    }

    const populated = await SpaceBooking.findById(existing._id)
      .populate(
        'spaceId',
        'name category day price capacity status spaceType spaceCode imageUrl',
      )
      .lean();

    return res.status(200).json({
      success: true,
      message: 'Space booking updated successfully.',
      booking: serializeBooking(populated),
    });
  } catch (error) {
    if (error instanceof BookingValidationError) {
      return sendBookingValidationError(res, error);
    }
    console.error('updateSpaceBooking error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update space booking.',
    });
  }
};

const money = value =>
  Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const spaceMembershipForPhone = async phone => {
  const digits = String(phone || '').replace(/\D/g, '').slice(-10);
  if (digits.length !== 10) return null;
  const customer = await Customer.findOne({
    $or: [
      {mobile: digits},
      {whatsappNumber: {$in: [digits, `+91${digits}`, `91${digits}`]}},
    ],
  })
    .select('name mobile membershipType membershipPlanId membershipPurchase')
    .lean();
  if (!customer) return null;
  const type = String(customer.membershipType || '').trim();
  const empty = {
    customerId: String(customer._id),
    type: '',
    label: '',
    planId: '',
    percent: 0,
  };
  if (!type || type.toLowerCase() === 'none' || (await isCustomerMembershipExpired(customer))) {
    return empty;
  }
  let plan = null;
  if (customer.membershipPlanId && mongoose.Types.ObjectId.isValid(String(customer.membershipPlanId))) {
    plan = await Membership.findOne({_id: customer.membershipPlanId, status: 'Active'}).lean();
  }
  if (!plan) {
    const pattern = new RegExp(`^${type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    plan = await Membership.findOne({
      status: 'Active',
      $or: [{planId: pattern}, {displayName: pattern}],
    }).lean();
  }
  const limits = plan?.usageLimits;
  const limitMap = limits && typeof limits.entries === 'function'
    ? Object.fromEntries(limits.entries())
    : limits || {};
  const limitKey = Object.keys(limitMap).find(name => ['space', 'spaces'].includes(String(name).toLowerCase()));
  const fromLimit = Number(limitMap[limitKey]?.discount) || 0;
  const percent = fromLimit > 0
    ? fromLimit
    : Number(plan?.customerDisplay?.spaceDiscountPercent) || 0;
  return {
    customerId: String(customer._id),
    type,
    label: String(plan?.displayName || plan?.planId || type),
    planId: plan?._id ? String(plan._id) : String(customer.membershipPlanId || ''),
    percent: Math.max(0, percent),
  };
};

const dateKeyFromInput = value => {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
};

const dayTypeFromKey = dateKey => {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  const weekDay = date.getDay();
  return weekDay === 0 || weekDay === 6 ? 'Weekend' : 'Weekday';
};

const staffActor = req => ({
  m_staff_id: req.user?.m_staff_id || req.user?.userId || null,
  m_staff_name: req.user?.name || null,
  m_staff_email: req.user?.email || null,
});

const bookingAmount = booking =>
  money(booking.grandTotal || booking.lineTotal || booking.unitPrice || 0);

const paymentPosition = (grand, paid) => {
  const safePaid = money(Math.max(0, paid));
  const rawDue = money(Math.max(0, grand - safePaid));
  // Nearest-rupee billing can leave under ₹1. That remainder is fully paid.
  const due = rawDue < 1 ? 0 : rawDue;
  const paymentStatus = due <= 0.009 ? 'full' : safePaid > 0 ? 'partial' : '';
  return {paidAmount: due === 0 ? money(grand) : safePaid, dueAmount: due, paymentStatus};
};

const escapeName = value => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const loadSpaceFamily = async spaceId => {
  const current = await Space.findById(spaceId)
    .select('name category day price status spaceType spaceCode')
    .lean();
  if (!current) return null;
  const name = String(current.name || '').trim();
  const siblings = name
    ? await Space.find({
        name: {$regex: `^\\s*${escapeName(name)}\\s*$`, $options: 'i'},
      })
        .select('name category day price status spaceType spaceCode')
        .lean()
    : [current];
  return {current, siblings};
};

const rateForSpaceDay = (siblings, wantedDay) => {
  const wanted = wantedDay === 'Weekend' ? 'Weekend' : 'Weekday';
  const match = siblings.find(
    row => String(row.day || '').toLowerCase() === wanted.toLowerCase(),
  );
  if (!match || String(match.status || '').toLowerCase() === 'maintenance') {
    return {
      error: `${wanted} bookings are not available for this space.`,
    };
  }
  return {space: match, dayType: wanted, price: money(match.price)};
};

const pricedSpaceForDate = async (spaceId, wantedDay) => {
  const family = await loadSpaceFamily(spaceId);
  if (!family) return null;
  return rateForSpaceDay(family.siblings, wantedDay);
};

const enforceCatalogueSpacePrice = async payload => {
  if (!payload?.spaceId) return null;
  const family = await loadSpaceFamily(payload.spaceId);
  if (!family) return 'Selected space was not found.';

  const snapshot = payload.summarySnapshot || {};
  const isDuration = Boolean(snapshot.isDurationPlan);
  const multi =
    payload.dateMode === 'multiple' &&
    Array.isArray(payload.multiDateSlots) &&
    payload.multiDateSlots.length > 0;
  const qty = Math.max(1, Number(payload.spaceQty) || 1);
  const slots = [];

  if (multi) {
    for (const slot of payload.multiDateSlots) {
      const date = dateKeyFromInput(slot.date);
      if (!date) continue;
      const hours = Number(slot.duration) > 0 ? Number(slot.duration) : 1;
      slots.push({date, units: hours * qty});
    }
  } else {
    const date = dateKeyFromInput(
      payload.bookingDate || payload.coworkingStartDate || snapshot.bookingDate,
    );
    if (!date) return null;
    const start = toMinutes(payload.startTime);
    const end = toMinutes(payload.endTime);
    const hours =
      start != null && end != null && end > start
        ? (end - start) / 60
        : Number(payload.durationHours) || 1;
    const units = isDuration
      ? Math.max(1, Number(snapshot.packageMultiplier) || 1) * qty
      : Math.max(0, hours) * qty;
    slots.push({date, units});
  }

  if (!slots.length) return null;

  let charge = 0;
  let primary = null;
  for (const slot of slots) {
    const rated = rateForSpaceDay(family.siblings, dayTypeFromKey(slot.date));
    if (rated.error) return rated.error;
    if (!primary) primary = rated;
    charge += rated.price * slot.units;
  }
  charge = money(charge);

  const clientSpace = money(
    Array.isArray(snapshot.selectedSpaces) && snapshot.selectedSpaces.length
      ? snapshot.selectedSpaces.reduce(
          (sum, row) => sum + Number(row.lineTotal || 0),
          0,
        )
      : Number(snapshot.spaceCharges || 0),
  );
  const delta = clientSpace > 0 ? money(charge - clientSpace) : 0;

  payload.unitPrice = primary.price;
  payload.spaceDay = primary.dayType;
  payload.spaceId = String(primary.space._id);
  payload.spaceName = primary.space.name || payload.spaceName;
  payload.spaceCode = primary.space.spaceCode || payload.spaceCode;
  if (clientSpace > 0) {
    if (payload.lineTotal != null) {
      payload.lineTotal = money(Math.max(0, Number(payload.lineTotal) + delta));
    }
    if (payload.grandTotal != null) {
      payload.grandTotal = money(Math.max(0, Number(payload.grandTotal) + delta));
    }
    if (payload.summarySnapshot) {
      payload.summarySnapshot.unitPrice = primary.price;
      payload.summarySnapshot.spaceDay = primary.dayType;
      payload.summarySnapshot.spaceCharges = charge;
    }
  }
  return null;
};

const loadOpenBooking = async id => {
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return {error: {status: 400, message: 'Invalid booking id.'}};
  }
  const booking = await SpaceBooking.findById(id);
  if (!booking) return {error: {status: 404, message: 'Space booking not found.'}};
  if (booking.status === 'Cancelled') {
    return {error: {status: 400, message: 'A cancelled booking cannot be changed.'}};
  }
  return {booking};
};

const quoteForBooking = async (booking, {bookingDate, startTime, endTime, dayType}) => {
  const dateKey = dateKeyFromInput(bookingDate);
  if (!dateKey) return {error: 'A valid booking date is required.'};
  if (!TIME_RE.test(String(startTime || '')) || !isEndTime(endTime)) {
    return {error: 'Valid start and end times are required (HH:mm).'};
  }
  if (toMinutes(endTime) <= toMinutes(startTime)) {
    return {error: 'End time must be after start time.'};
  }
  if (booking.dateMode === 'multiple' || booking.summarySnapshot?.isDurationPlan) {
    return {error: 'Reschedule is available for a single date and time slot.'};
  }
  const requested = String(dayType || '').trim().toLowerCase();
  const wanted = requested === 'weekend'
    ? 'Weekend'
    : requested === 'weekday'
      ? 'Weekday'
      : dayTypeFromKey(dateKey);
  const priced = await pricedSpaceForDate(booking.spaceId, wanted);
  if (!priced) return {error: 'Selected space was not found.'};
  if (priced.error) return {error: priced.error};
  const hours = money((toMinutes(endTime) - toMinutes(startTime)) / 60);
  const hourlyRate = priced.price > 0 ? priced.price : money(booking.unitPrice || 0);
  const previousAmount = bookingAmount(booking);
  const slotHours = money((toMinutes(booking.endTime) - toMinutes(booking.startTime)) / 60);
  const currentHours = slotHours > 0 ? slotHours : money(booking.durationHours || 0);
  const currentDayText = String(booking.spaceDay || '').trim().toLowerCase();
  const currentDay = currentDayText.startsWith('weekend')
    ? 'Weekend'
    : currentDayText.startsWith('weekday')
      ? 'Weekday'
      : dayTypeFromKey(dateKeyFromInput(booking.bookingDate) || dateKey);
  const sameDayAndDuration =
    currentDay === priced.dayType && Math.abs(hours - currentHours) < 0.001;
  const catalogueAmount = sameDayAndDuration
    ? previousAmount
    : hourlyRate > 0
      ? money(hourlyRate * hours)
      : previousAmount;
  const activeOffers = sameDayAndDuration
    ? []
    : await SpaceOffer.find({status: 'active', offerType: 'space_booking'}).lean();
  const offerQuote = sameDayAndDuration
    ? null
    : quoteBookingOffer({
        offers: activeOffers,
        hours,
        lines: [{hourlyRate, qty: Math.max(1, Number(booking.spaceQty) || 1)}],
      });
  const offerDiscount = sameDayAndDuration
    ? money(booking.offerDiscount || 0)
    : money(offerQuote?.discount || 0);
  const amountAfterOffer = sameDayAndDuration
    ? previousAmount
    : money(Math.max(0, catalogueAmount - offerDiscount));
  const membership = await spaceMembershipForPhone(booking.customerPhone);
  const membershipPercent = membership?.percent || 0;
  const membershipDiscount = !sameDayAndDuration && membershipPercent > 0
    ? money((amountAfterOffer * membershipPercent) / 100)
    : 0;
  // Same weekday or weekend and the same hours keeps the price already charged.
  // A changed slot uses the customer's current space membership on the new price.
  const newAmount = sameDayAndDuration
    ? previousAmount
    : money(Math.max(0, amountAfterOffer - membershipDiscount));
  const difference = money(newAmount - previousAmount);
  const paid = money(booking.paidAmount || 0);
  const nextDue = money(Math.max(0, newAmount - paid));
  const refundable = money(Math.max(0, paid - newAmount));
  return {
    quote: {
      bookingId: String(booking._id),
      customerName: booking.customerName,
      customerPhone: booking.customerPhone || '',
      customerId: membership?.customerId || '',
      membershipType: membership?.type || '',
      membershipLabel: membership?.label || '',
      membershipPlanId: membership?.planId || '',
      membershipPercent,
      membershipDiscount,
      spaceName: booking.spaceName,
      currentDate: booking.bookingDate,
      currentStart: booking.startTime,
      currentEnd: booking.endTime,
      currentDay,
      previousAmount,
      paidAmount: paid,
      newDate: dateKey,
      newStart: startTime,
      newEnd: endTime,
      newDay: priced.dayType,
      hourlyRate,
      hours,
      offerDiscount,
      offerSnapshot: sameDayAndDuration
        ? booking.offerSnapshot || null
        : offerQuote?.applied
          ? {
              offerId: offerQuote.offerId,
              offerName: offerQuote.offerName,
              minimumHours: offerQuote.minimumHours,
              freeHours: offerQuote.freeHours,
              chargeableHours: offerQuote.chargeableHours,
              originalAmount: offerQuote.originalAmount,
              discount: offerQuote.discount,
              finalAmount: offerQuote.finalAmount,
            }
          : null,
      newAmount,
      difference,
      additionalDue: difference > 0 ? money(Math.min(difference, nextDue)) : 0,
      pendingAfter: nextDue,
      refundable,
      spaceId: String(priced.space._id),
    },
  };
};

const applyWalletAdjustment = async ({
  booking,
  amount,
  type,
  walletType,
  note,
  referenceId,
  createdBy,
}) => {
  const phone = String(booking.customerPhone || '').replace(/\D/g, '').slice(-10);
  const customer = phone.length === 10
    ? await Customer.findOne({mobile: new RegExp(`${phone}$`)})
    : null;
  if (!customer) {
    throw new Error('Customer wallet was not found for this phone number.');
  }
  let wallet = await Wallet.findOne({customerId: customer._id});
  if (!wallet) {
    if (type === 'debit') throw new Error('Customer does not have a wallet balance.');
    wallet = await Wallet.create({
      customerId: customer._id,
      customerName: customer.name || booking.customerName,
      customerPhone: customer.mobile || booking.customerPhone,
      transactions: [],
    });
  }
  const duplicate = (wallet.transactions || []).some(
    tx => String(tx.referenceId || '') === referenceId,
  );
  if (duplicate) return;
  await appendTransaction(wallet, {
    type,
    amount,
    note,
    referenceType: 'SpaceBooking',
    referenceId,
    walletType: walletType || 'nonWithdrawable',
    createdBy,
  });
};

const reloadBooking = async id => {
  const populated = await SpaceBooking.findById(id)
    .populate(
      'spaceId',
      'name category day price capacity status spaceType spaceCode imageUrl',
    )
    .lean();
  return serializeBooking(populated);
};

export const quoteSpaceReschedule = async (req, res) => {
  try {
    const loaded = await loadOpenBooking(req.params.id);
    if (loaded.error) {
      return res.status(loaded.error.status).json({success: false, message: loaded.error.message});
    }
    const result = await quoteForBooking(loaded.booking, req.query);
    if (result.error) return res.status(400).json({success: false, message: result.error});
    return res.status(200).json({success: true, quote: result.quote});
  } catch (error) {
    console.error('quoteSpaceReschedule error:', error);
    return res.status(500).json({success: false, message: 'Failed to calculate the reschedule.'});
  }
};

export const rescheduleSpaceBooking = async (req, res) => {
  try {
    const loaded = await loadOpenBooking(req.params.id);
    if (loaded.error) {
      return res.status(loaded.error.status).json({success: false, message: loaded.error.message});
    }
    const booking = loaded.booking;
    const result = await quoteForBooking(booking, req.body || {});
    if (result.error) return res.status(400).json({success: false, message: result.error});
    const quote = result.quote;
    const actor = staffActor(req);
    const referenceId = `space-reschedule:${booking._id}:${quote.newDate}:${quote.newStart}:${quote.newAmount}`;
    const already = (booking.payments || []).some(row => row.referenceId === referenceId);
    if (already) {
      return res.status(200).json({
        success: true,
        message: 'This reschedule was already saved.',
        booking: await reloadBooking(booking._id),
      });
    }

    const paymentRow = req.body?.payment || null;
    const refundRow = req.body?.refund || null;
    if (quote.refundable > 0 && !['Wallet', 'UPI', 'Cash'].includes(String(refundRow?.mode || '').trim())) {
      return res.status(400).json({
        success: false,
        message: 'Choose Wallet, UPI, or Cash for the refund.',
      });
    }
    if (quote.additionalDue > 0) {
      const mode = String(paymentRow?.mode || '').trim();
      const amount = money(paymentRow?.amount);
      if (!['Cash', 'UPI', 'Wallet', 'Card'].includes(mode)) {
        return res.status(400).json({
          success: false,
          message: 'Choose UPI, Cash, Wallet, or Card for the additional amount.',
        });
      }
      if (Math.abs(amount - quote.additionalDue) > 0.009) {
        return res.status(400).json({
          success: false,
          message: 'Collect the full additional amount before rescheduling.',
        });
      }
    }

    const preview = {
      ...booking.toObject(),
      spaceId: quote.spaceId,
      bookingDate: new Date(`${quote.newDate}T00:00:00`),
      startTime: quote.newStart,
      endTime: quote.newEnd,
      dateMode: 'single',
      multiDateSlots: [],
    };
    const group = await resolveSpaceGroup(quote.spaceId);
    const {intervals, errors} = buildBookingIntervals(preview);
    if (!group || errors.length || !intervals.length) {
      return res.status(400).json({
        success: false,
        message: errors[0] || 'Selected space was not found.',
      });
    }

    await validateAndPersistSchedule({
      group,
      intervals,
      excludeId: booking._id,
      persist: async () => {
    let paid = money(booking.paidAmount || 0);
    if (!Array.isArray(booking.payments)) booking.payments = [];
    if (!Array.isArray(booking.reschedules)) booking.reschedules = [];

    if (quote.refundable > 0) {
      const mode = String(refundRow?.mode || '').trim();
      if (mode === 'Wallet') {
        await applyWalletAdjustment({
          booking,
          amount: quote.refundable,
          type: 'credit',
          walletType: refundRow.walletType || 'nonWithdrawable',
          note: `Refund adjustment for Space Booking Reschedule - ${booking._id}`,
          referenceId,
          createdBy: actor,
        });
      }
      booking.payments.push({
        kind: 'refund',
        amount: quote.refundable,
        mode,
        walletType: mode === 'Wallet' ? refundRow.walletType || 'nonWithdrawable' : '',
        note: `Refund adjustment for Space Booking Reschedule - ${booking._id}`,
        referenceId,
        createdBy: actor,
      });
      paid = money(paid - quote.refundable);
    }

    if (quote.additionalDue > 0 && paymentRow && Number(paymentRow.amount) > 0) {
      const collect = money(Math.min(Number(paymentRow.amount), quote.pendingAfter));
      const mode = String(paymentRow.mode || '').trim();
      const payRef = `${referenceId}:pay`;
      if (mode === 'Wallet') {
        await applyWalletAdjustment({
          booking,
          amount: collect,
          type: 'debit',
          walletType: paymentRow.walletType || 'nonWithdrawable',
          note: `Additional payment for Space Booking Reschedule - ${booking._id}`,
          referenceId: payRef,
          createdBy: actor,
        });
      }
      booking.payments.push({
        kind: 'payment',
        amount: collect,
        mode,
        walletType: mode === 'Wallet' ? paymentRow.walletType || 'nonWithdrawable' : '',
        note: `Additional payment for Space Booking Reschedule - ${booking._id}`,
        referenceId: payRef,
        createdBy: actor,
      });
      paid = money(paid + collect);
    }

    const position = paymentPosition(quote.newAmount, paid);
    if (!booking.originalAmount) booking.originalAmount = quote.previousAmount;
    booking.reschedules.push({
      previousDate: booking.bookingDate,
      newDate: new Date(`${quote.newDate}T00:00:00`),
      previousStart: booking.startTime,
      previousEnd: booking.endTime,
      newStart: quote.newStart,
      newEnd: quote.newEnd,
      previousDay: quote.currentDay,
      newDay: quote.newDay,
      previousAmount: quote.previousAmount,
      newAmount: quote.newAmount,
      difference: quote.difference,
      refundMode: quote.refundable > 0 ? String(refundRow?.mode || '') : '',
      paymentMode: quote.additionalDue > 0 ? String(paymentRow?.mode || '') : '',
      createdBy: actor,
    });
    booking.bookingDate = new Date(`${quote.newDate}T00:00:00`);
    booking.startTime = quote.newStart;
    booking.endTime = quote.newEnd;
    booking.spaceId = quote.spaceId;
    booking.spaceDay = quote.newDay;
    booking.unitPrice = quote.hourlyRate;
    booking.durationHours = quote.hours;
    booking.lineTotal = quote.newAmount;
    booking.grandTotal = quote.newAmount;
    booking.offerDiscount = money(quote.offerDiscount || 0);
    booking.offerSnapshot = quote.offerSnapshot || null;
    booking.paidAmount = position.paidAmount;
    booking.dueAmount = position.dueAmount;
    booking.paymentStatus = position.paymentStatus;
    if (booking.status !== 'Draft') {
      booking.status = computeBookingStatus(
        booking.bookingDate,
        booking.startTime,
        booking.endTime,
        booking.status,
      );
    }

        await booking.save();
      },
    });

    return res.status(200).json({
      success: true,
      message: 'Booking rescheduled.',
      booking: await reloadBooking(booking._id),
    });
  } catch (error) {
    if (error instanceof BookingValidationError) return sendBookingValidationError(res, error);
    console.error('rescheduleSpaceBooking error:', error);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to reschedule booking.',
    });
  }
};

export const receiveSpaceBookingPayment = async (req, res) => {
  try {
    const loaded = await loadOpenBooking(req.params.id);
    if (loaded.error) {
      return res.status(loaded.error.status).json({success: false, message: loaded.error.message});
    }
    const booking = loaded.booking;
    const due = money(booking.dueAmount || Math.max(0, bookingAmount(booking) - Number(booking.paidAmount || 0)));
    if (due <= 0.009) {
      return res.status(400).json({success: false, message: 'This booking has no pending amount.'});
    }
    const amount = money(req.body?.amount);
    const mode = String(req.body?.mode || '').trim();
    if (!(amount > 0) || amount - due > 0.009) {
      return res.status(400).json({success: false, message: `Enter an amount up to ₹${due.toFixed(2)}.`});
    }
    if (!['Cash', 'UPI', 'Wallet', 'Card'].includes(mode)) {
      return res.status(400).json({success: false, message: 'Choose Cash, UPI, or Wallet.'});
    }
    const referenceId = `space-payment:${booking._id}:${Date.now()}`;
    const actor = staffActor(req);
    if (mode === 'Wallet') {
      await applyWalletAdjustment({
        booking,
        amount,
        type: 'debit',
        walletType: req.body?.walletType || 'nonWithdrawable',
        note: `Pending payment for Space Booking - ${booking._id}`,
        referenceId,
        createdBy: actor,
      });
    }
    if (!Array.isArray(booking.payments)) booking.payments = [];
    booking.payments.push({
      kind: 'payment',
      amount,
      mode,
      walletType: mode === 'Wallet' ? req.body?.walletType || 'nonWithdrawable' : '',
      note: `Pending payment for Space Booking - ${booking._id}`,
      referenceId,
      createdBy: actor,
    });
    const position = paymentPosition(bookingAmount(booking), Number(booking.paidAmount || 0) + amount);
    booking.paidAmount = position.paidAmount;
    booking.dueAmount = position.dueAmount;
    booking.paymentStatus = position.paymentStatus;
    booking.paymentMode = mode;
    await booking.save();
    return res.status(200).json({
      success: true,
      message: 'Payment recorded.',
      booking: await reloadBooking(booking._id),
    });
  } catch (error) {
    console.error('receiveSpaceBookingPayment error:', error);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to record payment.',
    });
  }
};

export const deleteSpaceBooking = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid booking id.',
      });
    }

    const booking = await SpaceBooking.findById(id);
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Space booking not found.',
      });
    }

    const invoiceIds = new Set();
    if (booking.invoiceId && mongoose.Types.ObjectId.isValid(String(booking.invoiceId))) {
      invoiceIds.add(String(booking.invoiceId));
    }
    const code = String(booking.invoiceCode || '').trim();
    if (code) {
      const linked = await Invoice.findOne({invoiceCode: code}).select('_id').lean();
      if (linked?._id) invoiceIds.add(String(linked._id));
    }

    await SpaceBooking.findByIdAndDelete(id);
    for (const invoiceId of invoiceIds) {
      try {
        await purgeInvoiceById(invoiceId, req);
      } catch (invoiceError) {
        console.error('deleteSpaceBooking invoice cleanup error:', invoiceError);
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Space booking and its invoice were deleted.',
    });
  } catch (error) {
    console.error('deleteSpaceBooking error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete space booking.',
    });
  }
};

export const sendSpaceBookingQuotation = async (req, res) => {
  try {
    const phone = String(req.body?.phone || '').trim();
    const bodyParams = Array.isArray(req.body?.bodyParams) ? req.body.bodyParams : [];
    if (!phone) {
      return res.status(400).json({
        success: false,
        message: 'Add the customer phone number before sending the quotation.',
      });
    }
    if (bodyParams.length < 20) {
      return res.status(400).json({
        success: false,
        message: 'Booking details are incomplete.',
      });
    }
    const result = await sendSpaceBookingQuotationWhatsApp({to: phone, bodyParams});
    return res.status(200).json({
      success: true,
      delivered: Boolean(result?.delivered),
      stub: Boolean(result?.stub),
      message: result?.stub
        ? 'WhatsApp is not configured on the server, so the quotation was not delivered.'
        : 'Quotation sent on WhatsApp.',
    });
  } catch (error) {
    console.error('sendSpaceBookingQuotation error:', error);
    return res.status(502).json({
      success: false,
      message: error?.message || 'Could not send the quotation on WhatsApp.',
    });
  }
};

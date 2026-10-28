import mongoose from 'mongoose';
import SpaceBooking from '../models/spaceBooking.model.js';
import Space from '../models/space.model.js';
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
  const m = String(timeStr || '').trim().match(TIME_RE);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};

const formatTimeDisplay = timeStr => {
  const mins = toMinutes(timeStr);
  if (mins == null) return String(timeStr || '');
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const period = h >= 12 ? 'PM' : 'AM';
  const displayH = h % 12 === 0 ? 12 : h % 12;
  return `${displayH}:${String(m).padStart(2, '0')} ${period}`;
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
    if (!TIME_RE.test(endTime)) errors.push('Valid end time is required (HH:mm).');
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

    const bookings = await SpaceBooking.find(query)
      .populate(
        'spaceId',
        'name category day price capacity status spaceType spaceCode imageUrl',
      )
      .sort({bookingDate: -1, startTime: 1, createdAt: -1})
      .lean();
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

    const booking = await SpaceBooking.findById(id)
      .populate(
        'spaceId',
        'name category day price capacity status spaceType spaceCode imageUrl',
      )
      .lean();

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

export const deleteSpaceBooking = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid booking id.',
      });
    }

    const booking = await SpaceBooking.findByIdAndDelete(id);
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Space booking not found.',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Space booking deleted successfully.',
    });
  } catch (error) {
    console.error('deleteSpaceBooking error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete space booking.',
    });
  }
};

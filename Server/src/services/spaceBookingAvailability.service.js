import {randomUUID} from 'crypto';
import mongoose from 'mongoose';
import SpaceBooking from '../models/spaceBooking.model.js';
import AllBooking from '../models/allBooking.model.js';
import Space, {COWORKING_CATEGORIES} from '../models/space.model.js';
import SpaceBookingLock from '../models/spaceBookingLock.model.js';

export const BOOKING_TIMEZONE = process.env.BOOKING_TIMEZONE || 'Asia/Kolkata';

/** Statuses that occupy the space. Expired is included because multi-day
 * bookings are marked Expired once their first slot ends. */
export const BLOCKING_STATUSES = ['Upcoming', 'Ongoing', 'Expired'];

export const BOOKING_MESSAGES = {
  PAST: 'Please select a future date and time.',
  ALREADY_BOOKED: 'This space is already booked for the selected time.',
  NO_LONGER_AVAILABLE: 'This time slot is no longer available.',
  BUSY: 'Another booking for this space is being processed. Please try again.',
};

const FULL_DAY_START = 9 * 60;
const FULL_DAY_END = 21 * 60;
const MAX_RANGE_DAYS = 400;
const LOCK_TTL_MS = 15000;
const LOCK_WAIT_MS = 5000;

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class BookingValidationError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const tzFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BOOKING_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const partsInTz = date => {
  const parts = {};
  for (const p of tzFormatter.formatToParts(date)) parts[p.type] = p.value;
  return parts;
};

export const isDateKey = value => {
  const m = DATE_KEY_RE.exec(String(value || ''));
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
};

/**
 * Calendar date ("YYYY-MM-DD") of a stored booking date in the business timezone.
 * Date-only strings saved via `new Date("YYYY-MM-DD")` land on UTC midnight,
 * which is read as the UTC calendar day; any other instant is read in the TZ.
 */
export const toDateKey = value => {
  if (value == null || value === '') return null;
  if (typeof value === 'string') {
    const head = value.trim().slice(0, 10);
    if (isDateKey(head)) return head;
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  if (
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0
  ) {
    return d.toISOString().slice(0, 10);
  }
  const p = partsInTz(d);
  return `${p.year}-${p.month}-${p.day}`;
};

export const nowInBusinessTz = (now = new Date()) => {
  const p = partsInTz(now);
  return {
    dateKey: `${p.year}-${p.month}-${p.day}`,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
};

export const addDaysToKey = (key, days) => {
  const m = DATE_KEY_RE.exec(key);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return d.toISOString().slice(0, 10);
};

export const daysBetweenKeys = (fromKey, toKey) => {
  const a = Date.parse(`${fromKey}T00:00:00Z`);
  const b = Date.parse(`${toKey}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
};

export const toMinutes = value => {
  const m = TIME_RE.exec(String(value || '').trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

const minutesToTime = mins =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

/**
 * Expands a booking (stored document or request payload) into the concrete
 * time intervals it occupies, mirroring how the booking modal builds payloads:
 * duration plan → one full day per date, multiple dates → each slot, else the single slot.
 */
export const buildBookingIntervals = booking => {
  const intervals = [];
  const errors = [];
  if (!booking) return {intervals, errors};

  const isDurationPlan = Boolean(booking.summarySnapshot?.isDurationPlan);

  if (isDurationPlan) {
    const startKey = toDateKey(booking.coworkingStartDate) || toDateKey(booking.bookingDate);
    const endKey = toDateKey(booking.coworkingEndDate) || startKey;
    if (!startKey) {
      errors.push('Start date is required.');
      return {intervals, errors};
    }
    if (endKey < startKey) {
      errors.push('End date must be on or after the start date.');
      return {intervals, errors};
    }
    const span = daysBetweenKeys(startKey, endKey);
    if (span > MAX_RANGE_DAYS) {
      errors.push(`Booking cannot span more than ${MAX_RANGE_DAYS} days.`);
      return {intervals, errors};
    }
    const s = toMinutes(booking.startTime);
    const e = toMinutes(booking.endTime);
    const start = s != null && e != null && e > s ? s : FULL_DAY_START;
    const end = s != null && e != null && e > s ? e : FULL_DAY_END;
    for (let i = 0; i <= span; i++) {
      intervals.push({date: addDaysToKey(startKey, i), start, end, fullDay: true});
    }
    return {intervals, errors};
  }

  const slots = Array.isArray(booking.multiDateSlots) ? booking.multiDateSlots : [];
  if (booking.dateMode === 'multiple' && slots.length > 0) {
    slots.forEach((slot, idx) => {
      const date = toDateKey(slot?.date);
      const start = toMinutes(slot?.startTime);
      const end = toMinutes(slot?.endTime);
      if (!date || start == null || end == null) {
        errors.push(`Row ${idx + 1}: a valid date and time slot are required.`);
        return;
      }
      if (end <= start) {
        errors.push(`Row ${idx + 1}: end time must be after start time.`);
        return;
      }
      intervals.push({date, start, end, fullDay: false});
    });
    return {intervals, errors};
  }

  const date = toDateKey(booking.bookingDate);
  const start = toMinutes(booking.startTime);
  const end = toMinutes(booking.endTime);
  if (!date || start == null || end == null) {
    errors.push('A valid booking date and time are required.');
  } else if (end <= start) {
    errors.push('End time must be after start time.');
  } else {
    intervals.push({date, start, end, fullDay: false});
  }
  return {intervals, errors};
};

export const intervalKey = iv => `${iv.date}|${iv.start}|${iv.end}`;

export const intervalsOverlap = (a, b) =>
  a.date === b.date && a.start < b.end && b.start < a.end;

export const isIntervalPast = (iv, now = nowInBusinessTz()) => {
  if (iv.date < now.dateKey) return true;
  if (iv.date > now.dateKey) return false;
  return iv.fullDay ? false : iv.start <= now.minutes;
};

export const findSelfOverlap = intervals => {
  const sorted = [...intervals].sort((a, b) =>
    a.date === b.date ? a.start - b.start : a.date < b.date ? -1 : 1,
  );
  for (let i = 1; i < sorted.length; i++) {
    if (intervalsOverlap(sorted[i - 1], sorted[i])) return [sorted[i - 1], sorted[i]];
  }
  return null;
};

const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isCoworkingSpace = space => {
  if (space.spaceType === 'Coworking') return true;
  if (space.spaceType === 'Exclusive') return false;
  const cat = String(space.category || '').toLowerCase();
  return COWORKING_CATEGORIES.some(c => c.toLowerCase() === cat);
};

/**
 * A physical space may have one Space document per pricing day (Weekday/Weekend)
 * sharing the same name; bookings on either row occupy the same room.
 * Only exclusive spaces are single-occupancy, so only they are conflict-checked.
 */
export const resolveSpaceGroup = async spaceId => {
  if (!mongoose.Types.ObjectId.isValid(String(spaceId || ''))) return null;
  const space = await Space.findById(spaceId)
    .select('name category spaceType')
    .lean();
  if (!space) return null;

  const name = String(space.name || '').trim();
  const siblings = name
    ? await Space.find({name: {$regex: `^\\s*${escapeRegex(name)}\\s*$`, $options: 'i'}})
        .select('_id')
        .lean()
    : [];
  const ids = new Set([String(space._id), ...siblings.map(s => String(s._id))]);

  return {
    space,
    spaceIds: [...ids],
    lockKey: `space:${name.toLowerCase() || String(space._id)}`,
    conflictScoped: !isCoworkingSpace(space),
  };
};

/** Occupied intervals for a space group within [fromKey, toKey] (inclusive). */
export const findBusyIntervals = async ({spaceIds, fromKey, toKey, excludeId = null}) => {
  const query = {
    spaceId: {$in: spaceIds},
    status: {$in: BLOCKING_STATUSES},
    $or: [
      {
        bookingDate: {
          $gte: new Date(`${addDaysToKey(fromKey, -1)}T00:00:00Z`),
          $lt: new Date(`${addDaysToKey(toKey, 2)}T00:00:00Z`),
        },
      },
      {'multiDateSlots.date': {$gte: fromKey, $lte: toKey}},
      {
        'summarySnapshot.isDurationPlan': true,
        coworkingStartDate: {$lte: toKey},
        coworkingEndDate: {$gte: fromKey},
      },
    ],
  };
  if (excludeId && mongoose.Types.ObjectId.isValid(String(excludeId))) {
    query._id = {$ne: new mongoose.Types.ObjectId(String(excludeId))};
  }

  const docs = await SpaceBooking.find(query)
    .select(
      '_id status bookingDate startTime endTime dateMode multiDateSlots coworkingStartDate coworkingEndDate summarySnapshot.isDurationPlan',
    )
    .lean();

  const combinedQuery = {
    spaceId: {$in: spaceIds},
    status: {$in: BLOCKING_STATUSES},
    bookingDate: {
      $gte: new Date(`${addDaysToKey(fromKey, -1)}T00:00:00Z`),
      $lt: new Date(`${addDaysToKey(toKey, 2)}T00:00:00Z`),
    },
  };
  if (excludeId && mongoose.Types.ObjectId.isValid(String(excludeId))) {
    combinedQuery._id = {$ne: new mongoose.Types.ObjectId(String(excludeId))};
  }
  const combinedDocs = await AllBooking.find(combinedQuery)
    .select('_id status bookingDate startTime endTime')
    .lean();

  const busy = [];
  for (const doc of [...docs, ...combinedDocs]) {
    const {intervals} = buildBookingIntervals(doc);
    for (const iv of intervals) {
      if (iv.date < fromKey || iv.date > toKey) continue;
      busy.push({
        date: iv.date,
        start: iv.start,
        end: iv.end,
        startTime: minutesToTime(iv.start),
        endTime: minutesToTime(iv.end),
        bookingId: String(doc._id),
        status: doc.status,
      });
    }
  }
  busy.sort((a, b) => (a.date === b.date ? a.start - b.start : a.date < b.date ? -1 : 1));
  return busy;
};

export const getAvailabilityRangeError = (fromKey, toKey) => {
  if (!isDateKey(fromKey) || !isDateKey(toKey)) return 'Dates must be in YYYY-MM-DD format.';
  if (toKey < fromKey) return '"to" must be on or after "from".';
  if (daysBetweenKeys(fromKey, toKey) > MAX_RANGE_DAYS) {
    return `Date range cannot exceed ${MAX_RANGE_DAYS} days.`;
  }
  return null;
};

/**
 * Validates a schedule and runs `persist` while holding the space lock, so
 * concurrent requests for the same space are checked one at a time.
 * `checkIntervals` limits past/conflict checks to newly requested intervals (edits).
 */
export const validateAndPersistSchedule = async ({
  group,
  intervals,
  checkIntervals = intervals,
  excludeId = null,
  persist,
}) => {
  if (checkIntervals.length === 0) return persist();

  const selfOverlap = findSelfOverlap(intervals);
  if (selfOverlap) {
    throw new BookingValidationError(
      400,
      'SELF_OVERLAP',
      `Selected time slots overlap on ${selfOverlap[0].date}.`,
    );
  }

  const now = nowInBusinessTz();
  const past = checkIntervals.find(iv => isIntervalPast(iv, now));
  if (past) {
    throw new BookingValidationError(400, 'PAST_BOOKING', BOOKING_MESSAGES.PAST, {
      date: past.date,
      startTime: minutesToTime(past.start),
    });
  }

  if (!group.conflictScoped) return persist();

  const dates = checkIntervals.map(iv => iv.date).sort();
  return withSpaceLock(group.lockKey, async () => {
    const busy = await findBusyIntervals({
      spaceIds: group.spaceIds,
      fromKey: dates[0],
      toKey: dates[dates.length - 1],
      excludeId,
    });
    const conflicts = [];
    for (const iv of checkIntervals) {
      for (const b of busy) {
        if (intervalsOverlap(iv, b)) {
          conflicts.push({date: b.date, startTime: b.startTime, endTime: b.endTime});
        }
      }
    }
    if (conflicts.length) {
      throw new BookingValidationError(
        409,
        'SLOT_CONFLICT',
        BOOKING_MESSAGES.NO_LONGER_AVAILABLE,
        {conflicts},
      );
    }
    return persist();
  });
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export const withSpaceLock = async (key, fn) => {
  const token = randomUUID();
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    const now = new Date();
    try {
      await SpaceBookingLock.findOneAndUpdate(
        {_id: key, expiresAt: {$lt: now}},
        {$set: {token, expiresAt: new Date(now.getTime() + LOCK_TTL_MS)}},
        {upsert: true, new: true},
      );
      break;
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
    if (Date.now() >= deadline) {
      throw new BookingValidationError(503, 'BOOKING_BUSY', BOOKING_MESSAGES.BUSY);
    }
    await sleep(60 + Math.floor(Math.random() * 90));
  }

  try {
    return await fn();
  } finally {
    await SpaceBookingLock.deleteOne({_id: key, token}).catch(() => undefined);
  }
};

import mongoose from 'mongoose';
import Space from '../../../models/space.model.js';
import SpaceBooking from '../../../models/spaceBooking.model.js';
import SpaceOffer from '../../../models/spaceOffer.model.js';
import Coupon from '../../../models/coupon.model.js';
import Customer from '../../../models/customer.model.js';
import Membership from '../../../models/membership.model.js';
import CustomerSpaceCheckout from '../../../models/customerSpaceCheckout.model.js';
import {isCustomerMembershipExpired} from '../../../services/membershipEligibility.service.js';
import {quoteBookingOffer} from '../../../services/spaceOffer.service.js';
import {validateCouponForOrder} from '../../../controllers/coupon.controller.js';
import {
  createRazorpayOrder,
  verifyRazorpaySignature,
} from '../../../services/razorpay.service.js';
import {
  BookingValidationError,
  buildBookingIntervals,
  findBusyIntervals,
  nowInBusinessTz,
  resolveSpaceGroup,
  toMinutes,
  validateAndPersistSchedule,
} from '../../../services/spaceBookingAvailability.service.js';

const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const fail = (status, message) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const escapeName = value => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const dayTypeFromKey = dateKey => {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getDay() === 0 || date.getDay() === 6 ? 'Weekend' : 'Weekday';
};

const membershipForCustomer = async customer => {
  const empty = {label: '', percent: 0};
  if (!customer) return empty;
  const type = String(customer.membershipType || '').trim();
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
    label: String(plan?.displayName || plan?.planId || type),
    percent: Math.max(0, percent),
  };
};

const priceForDate = async (spaceId, dateKey) => {
  const current = await Space.findById(spaceId)
    .select('name category day price status spaceType spaceCode')
    .lean();
  if (!current) return {error: 'Selected space was not found.'};
  const name = String(current.name || '').trim();
  const siblings = name
    ? await Space.find({name: {$regex: `^\\s*${escapeName(name)}\\s*$`, $options: 'i'}})
        .select('name category day price status spaceType spaceCode')
        .lean()
    : [current];
  const wanted = dayTypeFromKey(dateKey);
  const match = siblings.find(row => String(row.day || '').toLowerCase() === wanted.toLowerCase()) || current;
  if (String(match.status || '').toLowerCase() === 'maintenance') {
    return {error: `${wanted} bookings are not available for this space.`};
  }
  return {
    space: match,
    dayType: wanted,
    hourlyRate: money(match.price),
  };
};

const slotTaken = async (spaceId, dateKey, startTime, endTime) => {
  const group = await resolveSpaceGroup(spaceId);
  if (!group) return 'Selected space was not found.';
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  const busy = await findBusyIntervals({spaceIds: group.spaceIds, fromKey: dateKey, toKey: dateKey});
  const hit = busy.find(row => {
    if (row.date !== dateKey) return false;
    const a = toMinutes(row.startTime);
    const b = toMinutes(row.endTime);
    return a != null && b != null && start < b && a < end;
  });
  return hit ? 'This time slot is no longer available.' : '';
};

export const quoteCustomerSpaceBooking = async (customer, body = {}) => {
  const spaceId = String(body.spaceId || '').trim();
  const bookingDate = String(body.bookingDate || '').trim();
  const startTime = String(body.startTime || '').trim();
  const endTime = String(body.endTime || '').trim();
  if (!mongoose.Types.ObjectId.isValid(spaceId)) throw fail(400, 'A valid space is required.');
  if (!DATE_RE.test(bookingDate)) throw fail(400, 'A valid booking date is required.');
  if (!TIME_RE.test(startTime) || !(endTime === '24:00' || TIME_RE.test(endTime))) {
    throw fail(400, 'Valid start and end times are required.');
  }
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  if (start == null || end == null || end <= start) throw fail(400, 'End time must be after start time.');
  if (start < 6 * 60 || end > 24 * 60) throw fail(400, 'Bookings are available from 6:00 AM to midnight.');

  const now = nowInBusinessTz();
  if (bookingDate < now.dateKey || (bookingDate === now.dateKey && start <= now.minutes)) {
    throw fail(400, 'Please select a future date and time.');
  }

  const priced = await priceForDate(spaceId, bookingDate);
  if (priced.error) throw fail(400, priced.error);
  const hours = money((end - start) / 60);
  const baseAmount = money(priced.hourlyRate * hours);
  const offers = await SpaceOffer.find({status: 'active', offerType: 'space_booking'}).lean();
  const offerQuote = quoteBookingOffer({
    offers,
    hours,
    lines: [{hourlyRate: priced.hourlyRate, qty: 1}],
  });
  const offerDiscount = money(offerQuote.discount || 0);
  const afterOffer = money(Math.max(0, baseAmount - offerDiscount));
  const membership = await membershipForCustomer(customer);
  const membershipDiscount = membership.percent > 0
    ? money((afterOffer * membership.percent) / 100)
    : 0;
  const afterMembership = money(Math.max(0, afterOffer - membershipDiscount));

  let coupon = null;
  let couponError = '';
  const couponCode = String(body.couponCode || '').trim();
  if (couponCode) {
    if (afterMembership <= 0) {
      couponError = 'Nothing left to discount.';
    } else {
      const phone = String(customer.mobile || '').replace(/\D/g, '').slice(-10);
      const validated = await validateCouponForOrder({
        code: couponCode,
        orderAmount: afterMembership,
        customerPhone: phone,
        applicableContext: 'space',
      });
      if (!validated.ok) couponError = validated.message;
      else {
        const prior = await SpaceBooking.countDocuments({
          customerPhone: {$regex: `${phone}$`},
          couponCode: validated.normalizedCode,
          status: {$ne: 'Cancelled'},
        });
        const limit = Number(validated.coupon?.perCustomerLimit || 0);
        if (limit > 0 && prior >= limit) couponError = 'Coupon already used maximum times by this customer.';
        else {
          coupon = {
            code: validated.normalizedCode,
            title: validated.coupon.title,
            discount: money(Math.min(afterMembership, validated.discountAmount)),
          };
        }
      }
    }
  }

  const payable = money(Math.max(0, afterMembership - (coupon?.discount || 0)));
  const publicCoupons = await Coupon.find({
    isActive: true,
    applicableOn: {$in: ['space', 'all']},
    expiresAt: {$gte: new Date()},
    $or: [{startsAt: null}, {startsAt: {$lte: new Date()}}],
  })
    .select('code title discountType discountValue minOrderAmount expiresAt')
    .limit(12)
    .lean();

  return {
    spaceId: String(priced.space._id),
    spaceName: priced.space.name,
    spaceCode: priced.space.spaceCode || '',
    spaceType: priced.space.spaceType || '',
    spaceCategory: priced.space.category || '',
    dayType: priced.dayType,
    bookingDate,
    startTime,
    endTime,
    hours,
    hourlyRate: priced.hourlyRate,
    baseAmount,
    offer: offerQuote.applied
      ? {
          name: offerQuote.offerName,
          freeHours: offerQuote.freeHours,
          minimumHours: offerQuote.minimumHours,
          discount: offerDiscount,
        }
      : null,
    offers: offers.map(offer => ({
      name: offer.offerName || 'Space offer',
      rules: (offer.rules || [])
        .filter(rule => String(rule.status || 'active') !== 'inactive')
        .map(rule => ({minimumHours: rule.minimumHours, freeHours: rule.freeHours})),
    })),
    membership: {
      label: membership.label,
      percent: membership.percent,
      discount: membershipDiscount,
    },
    coupon,
    couponError,
    coupons: publicCoupons.map(row => ({
      code: row.code,
      title: row.title,
      discountType: row.discountType,
      discountValue: row.discountValue,
      minOrderAmount: row.minOrderAmount || 0,
    })),
    payable,
  };
};

const createPaidBooking = async (customer, quote, payment) => {
  const phone = String(customer.mobile || '').replace(/\D/g, '').slice(-10);
  const bookingDate = new Date(`${quote.bookingDate}T00:00:00.000Z`);
  const payload = {
    customerName: String(customer.name || 'Customer').trim(),
    customerPhone: phone,
    customerEmail: String(customer.email || '').trim().toLowerCase(),
    spaceId: quote.spaceId,
    spaceName: quote.spaceName,
    spaceCode: quote.spaceCode,
    spaceType: quote.spaceType,
    spaceCategory: quote.spaceCategory,
    spaceDay: quote.dayType,
    unitPrice: quote.hourlyRate,
    durationHours: quote.hours,
    lineTotal: quote.payable,
    subTotal: quote.baseAmount,
    offerDiscount: quote.offer?.discount || 0,
    offerSnapshot: quote.offer
      ? {
          offerName: quote.offer.name,
          freeHours: quote.offer.freeHours,
          minimumHours: quote.offer.minimumHours,
        }
      : null,
    discountAmount: money((quote.membership?.discount || 0) + (quote.coupon?.discount || 0)),
    couponCode: quote.coupon?.code || '',
    grandTotal: quote.payable,
    paidAmount: quote.payable,
    dueAmount: 0,
    paymentStatus: 'full',
    paymentMode: quote.payable > 0 ? 'Razorpay' : 'Free',
    razorpayOrderId: payment.orderId || '',
    razorpayPaymentId: payment.paymentId || '',
    bookingDate,
    startTime: quote.startTime,
    endTime: quote.endTime,
    status: 'Upcoming',
    dateMode: 'single',
    notes: payment.paymentId
      ? `Customer self-booking. Razorpay payment ${payment.paymentId}. Order ${payment.orderId}.`
      : 'Customer self-booking. No payment due.',
    summarySnapshot: {
      source: 'customer',
      spaceCharges: quote.baseAmount,
      grandTotal: quote.payable,
      offerName: quote.offer?.name || '',
      membershipLabel: quote.membership?.label || '',
      membershipDiscount: quote.membership?.discount || 0,
      couponCode: quote.coupon?.code || '',
      couponDiscount: quote.coupon?.discount || 0,
    },
    payments: quote.payable > 0
      ? [{
          kind: 'payment',
          amount: quote.payable,
          mode: 'Razorpay',
          referenceId: payment.paymentId || '',
          note: payment.orderId ? `Razorpay order ${payment.orderId}` : '',
        }]
      : [],
    createdBy: {
      m_staff_id: null,
      m_staff_name: 'Customer Portal',
      m_staff_email: customer.email || null,
    },
  };

  const group = await resolveSpaceGroup(quote.spaceId);
  const {intervals, errors} = buildBookingIntervals(payload);
  if (errors.length || !intervals.length) throw fail(400, errors[0] || 'A valid booking time is required.');
  const booking = await validateAndPersistSchedule({
    group,
    intervals,
    persist: () => SpaceBooking.create(payload),
  });
  if (quote.coupon?.code) {
    await Coupon.updateOne({code: quote.coupon.code}, {$inc: {usedCount: 1}});
  }
  return booking;
};

const publicBooking = booking => ({
  id: String(booking._id),
  bookingCode: String(booking._id).slice(-6).toUpperCase(),
  spaceName: booking.spaceName,
  bookingDate: booking.bookingDate,
  startTime: booking.startTime,
  endTime: booking.endTime,
  durationHours: booking.durationHours,
  grandTotal: booking.grandTotal,
  paidAmount: booking.paidAmount,
  paymentStatus: booking.paymentStatus,
  paymentMode: booking.paymentMode,
  status: booking.status,
  razorpayPaymentId: booking.razorpayPaymentId || '',
});

export const startCustomerSpaceCheckout = async (customer, body = {}) => {
  const quote = await quoteCustomerSpaceBooking(customer, body);
  if (quote.couponError && String(body.couponCode || '').trim()) {
    throw fail(400, quote.couponError);
  }
  const taken = await slotTaken(quote.spaceId, quote.bookingDate, quote.startTime, quote.endTime);
  if (taken) throw fail(409, taken);

  if (quote.payable < 1) {
    const booking = await createPaidBooking(customer, quote, {});
    return {mode: 'free', booking: publicBooking(booking), quote};
  }

  const receipt = `sp_${String(customer.mobile || customer._id).slice(-10)}_${Date.now().toString(36)}`.slice(0, 40);
  const order = await createRazorpayOrder({
    amount: quote.payable,
    currency: 'INR',
    receipt,
    notes: {
      customerId: String(customer._id),
      spaceId: quote.spaceId,
      bookingDate: quote.bookingDate,
    },
  });
  await CustomerSpaceCheckout.create({
    customer: customer._id,
    spaceId: quote.spaceId,
    bookingDate: quote.bookingDate,
    startTime: quote.startTime,
    endTime: quote.endTime,
    couponCode: quote.coupon?.code || '',
    payable: quote.payable,
    quote,
    razorpayOrderId: order.id,
    status: 'pending',
  });
  return {
    mode: 'razorpay',
    keyId: String(process.env.RAZORPAY_KEY_ID || '').trim(),
    orderId: order.id,
    amount: order.amount,
    currency: order.currency || 'INR',
    quote,
  };
};

export const verifyCustomerSpaceCheckout = async (customer, body = {}) => {
  const razorpayOrderId = String(body.razorpayOrderId || '').trim();
  const razorpayPaymentId = String(body.razorpayPaymentId || '').trim();
  const razorpaySignature = String(body.razorpaySignature || '').trim();
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    throw fail(400, 'Payment confirmation is incomplete.');
  }
  if (!verifyRazorpaySignature({razorpayOrderId, razorpayPaymentId, razorpaySignature})) {
    throw fail(400, 'Payment could not be verified.');
  }

  const existing = await CustomerSpaceCheckout.findOne({
    razorpayOrderId,
    customer: customer._id,
    status: 'paid',
  });
  if (existing?.bookingId) {
    const booking = await SpaceBooking.findById(existing.bookingId);
    if (booking) return {alreadyConfirmed: true, booking: publicBooking(booking)};
  }

  const checkout = await CustomerSpaceCheckout.findOneAndUpdate(
    {razorpayOrderId, customer: customer._id, status: 'pending'},
    {$set: {status: 'verifying', razorpayPaymentId}},
    {new: true},
  );
  if (!checkout) throw fail(409, 'This payment is already being confirmed.');

  try {
    const freshCustomer = await Customer.findById(customer._id);
    const quote = await quoteCustomerSpaceBooking(freshCustomer, {
      spaceId: checkout.spaceId,
      bookingDate: checkout.bookingDate,
      startTime: checkout.startTime,
      endTime: checkout.endTime,
      couponCode: checkout.couponCode,
    });
    if (Math.abs(money(quote.payable) - money(checkout.payable)) >= 1) {
      throw fail(409, 'The booking price changed. Please review the slot and pay again.');
    }
    const taken = await slotTaken(quote.spaceId, quote.bookingDate, quote.startTime, quote.endTime);
    if (taken) {
      checkout.status = 'slot_taken';
      await checkout.save();
      throw fail(409, 'Payment was received, but the slot was just taken. Please contact the studio with your payment id.');
    }
    const booking = await createPaidBooking(freshCustomer, quote, {
      orderId: razorpayOrderId,
      paymentId: razorpayPaymentId,
    });
    checkout.status = 'paid';
    checkout.bookingId = booking._id;
    checkout.razorpayPaymentId = razorpayPaymentId;
    await checkout.save();
    return {alreadyConfirmed: false, booking: publicBooking(booking)};
  } catch (error) {
    if (checkout.status === 'verifying') {
      checkout.status = 'pending';
      await checkout.save();
    }
    if (error instanceof BookingValidationError) {
      checkout.status = error.code === 'PAST_BOOKING' || error.code === 'SLOT_CONFLICT' ? 'slot_taken' : 'pending';
      await checkout.save();
      throw fail(error.status || 409, error.message);
    }
    throw error;
  }
};

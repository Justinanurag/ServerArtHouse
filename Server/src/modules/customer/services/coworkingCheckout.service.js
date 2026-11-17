import mongoose from 'mongoose';
import AllBooking from '../../../models/allBooking.model.js';
import Space from '../../../models/space.model.js';
import CustomerSpaceCheckout from '../../../models/customerSpaceCheckout.model.js';
import {validateCouponForOrder} from '../../../controllers/coupon.controller.js';
import {createRazorpayOrder, verifyRazorpaySignature} from '../../../services/razorpay.service.js';

const money = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const fail = (status, message) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const PLANS = {
  day: {id: 'day', subtitle: 'Daily (1 Day)', regularPrice: 399, memberPrice: 319, days: 1},
  weekly: {id: 'weekly', subtitle: 'Weekly (7 Days)', regularPrice: 2599, memberPrice: 2079, days: 7},
  monthly: {id: 'monthly', subtitle: 'Monthly (30 Days)', regularPrice: 7999, memberPrice: 5999, days: 30},
  '3months': {id: '3months', subtitle: '3 Months (90 Days)', regularPrice: 19999, memberPrice: 13999, days: 90},
  '6months': {id: '6months', subtitle: '6 Months (180 Days)', regularPrice: 39998, memberPrice: 27999, days: 180},
};

const MEMBERSHIP = {name: 'Premium Membership (365 Days)', regularPrice: 1999, price: 1499, days: 365};

const addDays = (key, days) => {
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${mm}-${dd}`;
};

const pretty = key => {
  const [year, month, day] = key.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
};

export const quoteCoworkingBooking = async (customer, body = {}) => {
  const plan = PLANS[String(body.planId || '').trim()];
  if (!plan) throw fail(400, 'Choose a coworking plan.');
  const startDate = String(body.startDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw fail(400, 'Choose a start date.');
  const drink = String(body.drink || 'Tea').trim() === 'Coffee' ? 'Coffee' : 'Tea';
  const regularTotal = money(MEMBERSHIP.regularPrice + plan.regularPrice);
  const yourPrice = money(MEMBERSHIP.price + plan.memberPrice);
  let coupon = null;
  let couponError = '';
  const couponCode = String(body.couponCode || '').trim();
  if (couponCode) {
    const phone = String(customer.mobile || '').replace(/\D/g, '').slice(-10);
    const validated = await validateCouponForOrder({
      code: couponCode,
      orderAmount: yourPrice,
      customerPhone: phone,
      applicableContext: 'space',
    });
    if (!validated.ok) couponError = validated.message;
    else {
      coupon = {
        code: validated.normalizedCode,
        discount: money(Math.min(yourPrice, validated.discountAmount)),
      };
    }
  }
  const payable = money(Math.max(0, yourPrice - (coupon?.discount || 0)));
  const coworkingEnd = addDays(startDate, plan.days - 1);
  const membershipEnd = addDays(startDate, MEMBERSHIP.days - 1);
  return {
    planId: plan.id,
    planName: plan.subtitle,
    drink,
    startDate,
    coworkingEnd,
    membershipEnd,
    membershipName: MEMBERSHIP.name,
    regularTotal,
    yourPrice,
    coupon,
    couponError,
    payable,
    savings: money(regularTotal - payable),
    spaceId: mongoose.Types.ObjectId.isValid(String(body.spaceId || '')) ? String(body.spaceId) : '',
  };
};

const createBooking = async (customer, quote, payment) => {
  let space = null;
  if (quote.spaceId) space = await Space.findById(quote.spaceId).select('name spaceCode category').lean();
  const phone = String(customer.mobile || '').replace(/\D/g, '').slice(-10);
  const booking = await AllBooking.create({
    customerId: customer._id,
    customerName: String(customer.name || 'Customer').trim(),
    customerPhone: phone,
    customerEmail: String(customer.email || '').trim().toLowerCase(),
    spaceId: space?._id || null,
    spaceName: space?.name || `CoWorking Plan – ${quote.planName}`,
    spaceCode: space?.spaceCode || '',
    spaceType: 'Coworking',
    spaceCategory: quote.planName,
    unitPrice: quote.payable,
    bookingDate: new Date(`${quote.startDate}T00:00:00.000Z`),
    startTime: '06:00',
    endTime: '24:00',
    membershipType: 'Premium',
    membershipDiscount: money(quote.regularTotal - quote.yourPrice),
    subTotal: quote.regularTotal,
    grandTotal: quote.payable,
    paidAmount: quote.payable,
    dueAmount: 0,
    status: 'Upcoming',
    paymentStatus: 'full',
    notes: [
      quote.membershipName,
      `Membership ${pretty(quote.startDate)} – ${pretty(quote.membershipEnd)}`,
      `Coworking ${pretty(quote.startDate)} – ${pretty(quote.coworkingEnd)}`,
      `Drink: ${quote.drink}`,
      payment.paymentId ? `Razorpay payment ${payment.paymentId}` : 'No payment due',
    ].join('. '),
    payments: quote.payable > 0
      ? [{
          amount: quote.payable,
          mode: 'Razorpay',
          referenceId: payment.paymentId || '',
          note: payment.orderId ? `Razorpay order ${payment.orderId}` : 'Coworking booking',
        }]
      : [],
    createdBy: {m_staff_name: 'Customer Portal', m_staff_email: customer.email || null},
  });
  booking.bookingCode = `AB-${String(booking._id).slice(-6).toUpperCase()}`;
  await booking.save();
  return booking;
};

const publicBooking = (booking, quote) => ({
  id: String(booking._id),
  bookingCode: booking.bookingCode,
  planName: quote?.planName || booking.spaceCategory || '',
  spaceName: booking.spaceName,
  drink: quote?.drink || '',
  startDate: quote?.startDate || '',
  coworkingEnd: quote?.coworkingEnd || '',
  membershipEnd: quote?.membershipEnd || '',
  membershipName: quote?.membershipName || 'Premium Membership (365 Days)',
  regularTotal: quote?.regularTotal ?? booking.subTotal,
  payable: booking.grandTotal,
  savings: quote?.savings ?? money((booking.subTotal || 0) - (booking.grandTotal || 0)),
  paymentStatus: booking.paymentStatus,
  paymentMode: booking.payments?.[0]?.mode || 'Razorpay',
  razorpayPaymentId: booking.payments?.[0]?.referenceId || '',
  status: booking.status,
  notes: booking.notes || '',
});

export const startCoworkingCheckout = async (customer, body = {}) => {
  const quote = await quoteCoworkingBooking(customer, body);
  if (quote.couponError && String(body.couponCode || '').trim()) throw fail(400, quote.couponError);
  if (quote.payable < 1) {
    const booking = await createBooking(customer, quote, {});
    return {mode: 'free', booking: publicBooking(booking, quote), quote};
  }
  const order = await createRazorpayOrder({
    amount: quote.payable,
    currency: 'INR',
    receipt: `cw_${String(customer.mobile || customer._id).slice(-10)}_${Date.now().toString(36)}`.slice(0, 40),
    notes: {customerId: String(customer._id), planId: quote.planId, startDate: quote.startDate},
  });
  await CustomerSpaceCheckout.create({
    customer: customer._id,
    spaceId: quote.spaceId || null,
    bookingDate: quote.startDate,
    startTime: '06:00',
    endTime: '24:00',
    couponCode: quote.coupon?.code || '',
    payable: quote.payable,
    quote: {...quote, kind: 'coworking'},
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

export const verifyCoworkingCheckout = async (customer, body = {}) => {
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
    const booking = await AllBooking.findById(existing.bookingId);
    if (booking) return {booking: publicBooking(booking, existing.quote)};
  }
  const checkout = await CustomerSpaceCheckout.findOneAndUpdate(
    {razorpayOrderId, customer: customer._id, status: 'pending'},
    {$set: {status: 'verifying', razorpayPaymentId}},
    {new: true},
  );
  if (!checkout?.quote) throw fail(409, 'This payment is already being confirmed.');
  try {
    const booking = await createBooking(customer, checkout.quote, {
      orderId: razorpayOrderId,
      paymentId: razorpayPaymentId,
    });
    checkout.status = 'paid';
    checkout.bookingId = booking._id;
    checkout.razorpayPaymentId = razorpayPaymentId;
    await checkout.save();
    return {booking: publicBooking(booking, checkout.quote)};
  } catch (error) {
    if (checkout.status === 'verifying') {
      checkout.status = 'pending';
      await checkout.save();
    }
    throw error;
  }
};

export const listMyCoworkingBookings = async customer => {
  const phone = String(customer.mobile || '').replace(/\D/g, '').slice(-10);
  const rows = await AllBooking.find({
    spaceType: 'Coworking',
    $or: [{customerId: customer._id}, ...(phone ? [{customerPhone: phone}] : [])],
  })
    .sort({createdAt: -1})
    .lean();
  return rows.map(row => {
    const payment = Array.isArray(row.payments) ? row.payments[0] : null;
    return {
      id: String(row._id),
      bookingCode: row.bookingCode || `AB-${String(row._id).slice(-6).toUpperCase()}`,
      planName: row.spaceCategory || row.spaceName,
      spaceName: row.spaceName,
      startDate: row.bookingDate,
      payable: row.grandTotal,
      regularTotal: row.subTotal,
      savings: money((row.subTotal || 0) - (row.grandTotal || 0)),
      paymentStatus: row.paymentStatus,
      paymentMode: payment?.mode || '',
      razorpayPaymentId: payment?.referenceId || '',
      status: row.status,
      notes: row.notes || '',
    };
  });
};

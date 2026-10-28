import PaymentOrder from '../models/paymentOrder.model.js';
import {
  createRazorpayOrder,
  verifyRazorpaySignature,
} from '../../../services/razorpay.service.js';
import {validateMembershipCoupon} from './coupon.service.js';
import {getMembershipOrderAmount} from '../constants/membershipPlans.js';
import {activateMembership} from './auth.service.js';
import Customer from '../../../models/customer.model.js';
import {assertActiveMembershipPlan, resolvePlanMeta} from '../../../services/membershipPlan.service.js';

const buildPricing = async ({customer, membershipType, couponCode}) => {
  const orderAmount = await getMembershipOrderAmount(membershipType);
  if (orderAmount == null) {
    const error = new Error('Select a valid membership plan');
    error.status = 400;
    throw error;
  }

  let discountAmount = 0;
  let normalizedCoupon = null;

  const rawCoupon = String(couponCode || '').trim();
  if (rawCoupon) {
    const validated = await validateMembershipCoupon({
      code: rawCoupon,
      membershipType,
      customerPhone: customer.mobile,
    });
    discountAmount = validated.discountAmount;
    normalizedCoupon = validated.code;
  }

  const paidAmount = Math.max(0, Math.round((orderAmount - discountAmount) * 100) / 100);
  return {orderAmount, discountAmount, paidAmount, couponCode: normalizedCoupon};
};

/**
 * Create a Razorpay order for membership purchase.
 * If paidAmount is 0 (full coupon), activates immediately and returns mode:'free'.
 */
export const initiateRazorpayMembershipPayment = async (customerId, payload = {}) => {
  const membershipType = String(payload.membershipType || '').toLowerCase();
  const plan = await assertActiveMembershipPlan(membershipType);
  const planMeta = resolvePlanMeta(plan);

  const customer = await Customer.findOne({
    _id: customerId,
    isDeleted: {$ne: true},
    status: 'active',
  });
  if (!customer) {
    const error = new Error('Customer not found');
    error.status = 404;
    throw error;
  }

  const pricing = await buildPricing({customer, membershipType, couponCode: payload.couponCode});

  // Fully discounted — no payment needed
  if (pricing.paidAmount <= 0) {
    const result = await activateMembership(customerId, {
      membershipType,
      couponCode: pricing.couponCode || undefined,
      skipPaymentCheck: true,
    });
    return {mode: 'free', activated: true, customer: result.customer, pricing};
  }

  const receipt = `mbr_${String(customer.mobile || customerId).slice(-10)}_${Date.now().toString(36)}`.slice(0, 40);

  const rzpOrder = await createRazorpayOrder({
    amount: pricing.paidAmount,
    currency: 'INR',
    receipt,
    notes: {
      customerId: String(customer._id),
      customerName: String(customer.name || ''),
      customerPhone: String(customer.mobile || ''),
      membershipType,
      planName: planMeta.label,
    },
  });

  const order = await PaymentOrder.create({
    txnid: rzpOrder.id,
    customer: customer._id,
    membershipType,
    couponCode: pricing.couponCode,
    orderAmount: pricing.orderAmount,
    discountAmount: pricing.discountAmount,
    paidAmount: pricing.paidAmount,
    status: 'created',
    gateway: 'razorpay',
  });

  return {
    mode: 'razorpay',
    activated: false,
    orderId: rzpOrder.id,
    amount: rzpOrder.amount,          // paise (for Razorpay widget)
    amountInRupees: pricing.paidAmount,
    currency: rzpOrder.currency,
    keyId: String(process.env.RAZORPAY_KEY_ID || '').trim(),
    dbOrderId: String(order._id),
    pricing,
    customer: {
      name: customer.name,
      email: customer.email,
      mobile: customer.mobile,
    },
    plan: {planName: planMeta.label, planId: membershipType},
  };
};

/**
 * Verify Razorpay payment signature and activate membership.
 */
export const verifyRazorpayMembershipPayment = async (customerId, payload = {}) => {
  const {razorpayOrderId, razorpayPaymentId, razorpaySignature} = payload;

  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    const error = new Error('razorpayOrderId, razorpayPaymentId, and razorpaySignature are required.');
    error.status = 400;
    throw error;
  }

  const isValid = verifyRazorpaySignature({razorpayOrderId, razorpayPaymentId, razorpaySignature});
  if (!isValid) {
    const error = new Error('Payment verification failed. Invalid signature.');
    error.status = 400;
    throw error;
  }

  const order = await PaymentOrder.findOne({txnid: razorpayOrderId, customer: customerId});
  if (!order) {
    const error = new Error('Payment order not found.');
    error.status = 404;
    throw error;
  }

  if (order.status === 'success' && order.activatedAt) {
    return {alreadyActivated: true, membershipType: order.membershipType, order};
  }

  order.status = 'success';
  order.gatewayStatus = 'captured';
  order.paymentMode = 'razorpay';
  order.mihpayid = razorpayPaymentId;
  order.rawResponse = {razorpayOrderId, razorpayPaymentId};
  await order.save();

  await activateMembership(order.customer, {
    membershipType: order.membershipType,
    couponCode: order.couponCode || undefined,
    paymentOrderId: order._id,
    skipPaymentCheck: true,
  });

  order.activatedAt = new Date();
  await order.save();

  return {alreadyActivated: false, membershipType: order.membershipType, order};
};

export const getPaymentStatus = async (customerId, txnid) => {
  const order = await PaymentOrder.findOne({
    txnid: String(txnid || '').trim(),
    customer: customerId,
  }).lean();

  if (!order) {
    const error = new Error('Payment not found');
    error.status = 404;
    throw error;
  }

  return {
    txnid: order.txnid,
    status: order.status,
    membershipType: order.membershipType,
    paidAmount: order.paidAmount,
    discountAmount: order.discountAmount,
    orderAmount: order.orderAmount,
    couponCode: order.couponCode,
    activatedAt: order.activatedAt,
    gateway: order.gateway,
  };
};

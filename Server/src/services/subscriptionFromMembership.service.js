import Counter from '../models/counter.model.js';
import Subscription from '../models/subscription.model.js';
import Membership from '../models/membership.model.js';
import Customer from '../models/customer.model.js';
import {resolvePlanMeta} from './membershipPlan.service.js';

const getNextSubscriptionNumber = async () => {
  const counter = await Counter.findOneAndUpdate(
    {key: 'subscription_number'},
    {$inc: {value: 1}},
    {new: true, upsert: true, setDefaultsOnInsert: true},
  );
  return counter.value;
};

const phoneVariants = phone => {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return [];
  const ten =
    digits.length === 12 && digits.startsWith('91')
      ? digits.slice(2)
      : digits.length >= 10
        ? digits.slice(-10)
        : digits;
  return [...new Set([digits, ten, `+91${ten}`, `91${ten}`, `0${ten}`].filter(Boolean))];
};

const computeEndDate = (start, periodRaw) => {
  const end = new Date(start);
  const period = String(periodRaw || 'Yearly').trim().toLowerCase();
  if (period.includes('lifetime')) {
    end.setFullYear(end.getFullYear() + 100);
  } else if (period.includes('month')) {
    end.setMonth(end.getMonth() + 1);
  } else {
    end.setFullYear(end.getFullYear() + 1);
  }
  return end;
};

const resolveRepeat = periodRaw => {
  const period = String(periodRaw || 'Yearly').trim().toLowerCase();
  if (period.includes('lifetime')) {
    return {repeatType: 'lifetime', repeatEvery: 1, repeatUnit: null};
  }
  if (period.includes('month')) {
    return {repeatType: 'monthly', repeatEvery: 1, repeatUnit: 'month'};
  }
  return {repeatType: 'yearly', repeatEvery: 1, repeatUnit: 'year'};
};

/**
 * Ensure a Subscription row exists after portal / Razorpay membership activation.
 * Idempotent per payment txn / paymentOrder / recent same-plan phone match.
 */
export const ensureSubscriptionForMembership = async ({
  customer,
  membershipType,
  membershipPlan = null,
  orderAmount = 0,
  discountAmount = 0,
  paidAmount = 0,
  couponCode = null,
  paymentOrder = null,
  createdBy = null,
} = {}) => {
  const phone = String(customer?.mobile || '').trim();
  const name = String(customer?.name || 'Customer').trim() || 'Customer';
  const planId = String(membershipType || '').trim().toLowerCase();
  if (!phone || !planId || planId === 'none') return null;

  let plan = membershipPlan;
  if (!plan) {
    plan = await Membership.findOne({
      planId,
      status: {$in: ['Active', 'active']},
    }).lean();
  }

  const meta = plan ? resolvePlanMeta(plan) : {label: `${planId} Membership`, validity: 'Yearly'};
  const amount = Math.max(
    0,
    Number(paidAmount ?? orderAmount ?? plan?.pricing?.amount ?? 0) || 0,
  );
  const listed = Math.max(0, Number(orderAmount ?? plan?.pricing?.amount ?? amount) || 0);
  const discount = Math.max(0, Number(discountAmount ?? 0) || 0);

  const txnid = String(paymentOrder?.txnid || '').trim();
  const paymentOrderId = paymentOrder?._id ? String(paymentOrder._id) : '';
  const variants = phoneVariants(phone);

  // Idempotency: already linked to this payment
  if (txnid || paymentOrderId) {
    const byPayment = await Subscription.findOne({
      $or: [
        ...(txnid ? [{notes: new RegExp(txnid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')}] : []),
        ...(paymentOrderId
          ? [{notes: new RegExp(paymentOrderId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')}]
          : []),
      ],
    }).lean();
    if (byPayment) return byPayment;
  }

  // Soft idempotency: active/recent same plan + phone
  const recent = await Subscription.findOne({
    customerPhone: {$in: variants},
    membershipType: planId,
    status: {$in: ['active', 'completed']},
    createdAt: {$gte: new Date(Date.now() - 24 * 60 * 60 * 1000)},
  }).lean();
  if (recent) return recent;

  const start = paymentOrder?.activatedAt
    ? new Date(paymentOrder.activatedAt)
    : customer?.membershipPurchase?.purchasedAt
      ? new Date(customer.membershipPurchase.purchasedAt)
      : new Date();
  const end = computeEndDate(start, plan?.pricing?.period || meta.validity);
  const repeat = resolveRepeat(plan?.pricing?.period || meta.validity);
  const priority = Math.max(0, Number(plan?.priority ?? customer?.priority ?? 0) || 0);

  const nextNumber = await getNextSubscriptionNumber();
  const subscriptionCode = `SUB-${nextNumber}`;
  const planLabel = String(plan?.displayName || meta.label || planId).trim();

  const gatewayNote = paymentOrder?.gateway
    ? `Gateway: ${String(paymentOrder.gateway)}`
    : 'Gateway: portal';
  const notes = [
    'Source: Customer portal membership activation',
    txnid ? `Payment txn: ${txnid}` : '',
    paymentOrderId ? `PaymentOrder: ${paymentOrderId}` : '',
    couponCode ? `Coupon: ${couponCode}` : '',
    gatewayNote,
  ]
    .filter(Boolean)
    .join(' | ');

  const subscription = await Subscription.create({
    subscriptionPrefix: 'SUB',
    subscriptionNumber: nextNumber,
    subscriptionCode,
    customerName: name,
    customerPhone: phone,
    membershipId: plan?._id ? String(plan._id) : String(customer?.membershipPlanId || ''),
    membershipPlanId: plan?._id ? String(plan._id) : String(customer?.membershipPlanId || ''),
    membershipType: planId,
    priority,
    invoiceDate: start,
    dueDate: end,
    startDate: start,
    endDate: end,
    ...repeat,
    salesPersonName: createdBy?.m_staff_name || 'Customer Portal',
    notes,
    status: 'active',
    items: [
      {
        productName: planLabel,
        qty: 1,
        unitPrice: listed,
        discount,
        lineTotal: amount,
      },
    ],
    students: [],
    subTotal: listed,
    discountTotal: discount,
    grandTotal: amount,
    coupon: couponCode
      ? {
          code: String(couponCode).toUpperCase(),
          title: '',
          discountAmount: discount,
        }
      : undefined,
    createdBy: createdBy || {
      m_staff_id: null,
      m_staff_name: 'Customer Portal',
      m_staff_email: null,
    },
  });

  // Keep customer priority aligned with plan
  if (customer?._id && priority > 0) {
    await Customer.updateOne(
      {_id: customer._id},
      {$set: {priority, membershipType: planId, membershipPlanId: plan?._id || customer.membershipPlanId}},
    );
  }

  return subscription;
};

/**
 * Backfill Subscription rows for customers who have an active membership
 * but no matching subscription document (legacy portal activations).
 */
export const backfillMissingMembershipSubscriptions = async ({limit = 200} = {}) => {
  const customers = await Customer.find({
    isDeleted: {$ne: true},
    membershipType: {$nin: [null, '', 'none']},
  })
    .select('name mobile membershipType membershipPlanId priority membershipPurchase')
    .sort({updatedAt: -1})
    .limit(limit)
    .lean();

  let created = 0;
  for (const customer of customers) {
    const variants = phoneVariants(customer.mobile);
    if (!variants.length) continue;

    // Match any non-cancelled sub for this phone (plan id may differ from customer.membershipType)
    const exists = await Subscription.exists({
      customerPhone: {$in: variants},
      status: {$nin: ['cancelled', 'draft']},
    });
    if (exists) continue;

    try {
      const plan = customer.membershipPlanId
        ? await Membership.findById(customer.membershipPlanId).lean()
        : await Membership.findOne({
            planId: String(customer.membershipType || '').toLowerCase(),
          }).lean();

      const sub = await ensureSubscriptionForMembership({
        customer,
        membershipType: customer.membershipType,
        membershipPlan: plan,
        orderAmount: customer.membershipPurchase?.orderAmount,
        discountAmount: customer.membershipPurchase?.discountAmount,
        paidAmount: customer.membershipPurchase?.paidAmount,
        couponCode: customer.membershipPurchase?.couponCode,
        paymentOrder: customer.membershipPurchase?.paymentOrderId
          ? {_id: customer.membershipPurchase.paymentOrderId, txnid: customer.membershipPurchase.txnid}
          : null,
        createdBy: {
          m_staff_id: null,
          m_staff_name: 'System backfill',
          m_staff_email: null,
        },
      });
      if (sub) created += 1;
    } catch (err) {
      console.error(
        '[Subscription backfill] failed for',
        customer.mobile,
        err?.message || err,
      );
    }
  }

  return {scanned: customers.length, created};
};

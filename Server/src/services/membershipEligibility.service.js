import Subscription from '../models/subscription.model.js';
import Membership from '../models/membership.model.js';

const last10 = value => {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
};

const phoneVariants = phone => {
  const ten = last10(phone);
  if (!ten) return [];
  return [...new Set([ten, `+91${ten}`, `91${ten}`, `0${ten}`])];
};

const hasMembership = customer => {
  const type = String(customer?.membershipType || '').trim().toLowerCase();
  return Boolean(type && !['none', 'guest', 'new'].includes(type));
};

/** A date-only expiry is valid through the end of that UTC day. */
const endInstant = value => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const midnight =
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 &&
    date.getUTCMilliseconds() === 0;
  if (midnight) date.setUTCHours(23, 59, 59, 999);
  return date;
};

const periodEnd = (start, periodRaw) => {
  const end = new Date(start);
  if (Number.isNaN(end.getTime())) return null;
  const period = String(periodRaw || 'yearly').trim().toLowerCase();
  if (period.includes('lifetime')) return null;
  if (period.includes('month')) end.setMonth(end.getMonth() + 1);
  else end.setFullYear(end.getFullYear() + 1);
  return end;
};

const matchingSubs = (customer, subs) => {
  const type = String(customer?.membershipType || '').trim().toLowerCase();
  const typed = subs.filter(
    sub => String(sub.membershipType || '').trim().toLowerCase() === type,
  );
  return typed.length ? typed : subs;
};

const verdictFromSubs = subs => {
  if (subs.some(sub => String(sub.repeatType || '') === 'lifetime')) {
    return {expired: false, endDate: null, known: true};
  }
  let latest = null;
  for (const sub of subs) {
    const end = endInstant(sub.endDate || sub.dueDate);
    if (end && (!latest || end.getTime() > latest.getTime())) latest = end;
  }
  if (latest) {
    return {expired: latest.getTime() < Date.now(), endDate: latest, known: true};
  }
  if (subs.some(sub => String(sub.status || '') === 'expired')) {
    return {expired: true, endDate: null, known: true};
  }
  return {expired: false, endDate: null, known: false};
};

const loadSubsByPhone = async customers => {
  const phones = new Set();
  for (const customer of customers) {
    for (const variant of phoneVariants(customer?.mobile || customer?.customerPhone)) {
      phones.add(variant);
    }
  }
  if (!phones.size) return new Map();
  const subs = await Subscription.find({
    customerPhone: {$in: [...phones]},
    status: {$nin: ['cancelled']},
  })
    .select('customerPhone endDate dueDate repeatType membershipType status')
    .lean();
  const grouped = new Map();
  for (const sub of subs) {
    const key = last10(sub.customerPhone);
    if (!key) continue;
    const list = grouped.get(key) || [];
    list.push(sub);
    grouped.set(key, list);
  }
  return grouped;
};

const loadPlans = async customers => {
  const ids = [];
  const planIds = [];
  for (const customer of customers) {
    if (customer?.membershipPlanId) ids.push(customer.membershipPlanId);
    const type = String(customer?.membershipType || '').trim().toLowerCase();
    if (type && !['none', 'guest', 'new'].includes(type)) planIds.push(type);
  }
  const [byId, byPlan] = await Promise.all([
    ids.length
      ? Membership.find({_id: {$in: ids}}).select('pricing planId').lean()
      : [],
    planIds.length
      ? Membership.find({planId: {$in: planIds}}).select('pricing planId').lean()
      : [],
  ]);
  return {byId, byPlan};
};

const planFor = (customer, plans) => {
  const id = customer?.membershipPlanId ? String(customer.membershipPlanId) : '';
  if (id) {
    const match = plans.byId.find(plan => String(plan._id) === id);
    if (match) return match;
  }
  const type = String(customer?.membershipType || '').trim().toLowerCase();
  return plans.byPlan.find(plan => String(plan.planId || '').toLowerCase() === type) || null;
};

const verdictFromPurchase = (customer, plan) => {
  const start = customer?.membershipPurchase?.purchasedAt;
  if (!start) return {expired: false, endDate: null};
  const period = plan?.pricing?.period;
  if (String(period || '').toLowerCase().includes('lifetime')) {
    return {expired: false, endDate: null};
  }
  const end = periodEnd(start, period);
  if (!end) return {expired: false, endDate: null};
  return {expired: end.getTime() < Date.now(), endDate: end};
};

/**
 * True only when the customer has a membership and its expiry date has passed.
 * Lifetime plans, and memberships with no date on record, are not treated as expired.
 */
export const isCustomerMembershipExpired = async customer => {
  if (!customer || !hasMembership(customer)) return false;
  const [grouped, plans] = await Promise.all([
    loadSubsByPhone([customer]),
    loadPlans([customer]),
  ]);
  const subs = matchingSubs(customer, grouped.get(last10(customer.mobile)) || []);
  const fromSub = verdictFromSubs(subs);
  if (fromSub.known) return fromSub.expired;
  return verdictFromPurchase(customer, planFor(customer, plans)).expired;
};

/** Adds membershipExpired and membershipEndDate onto lean customer rows. */
export const attachMembershipExpiry = async customers => {
  const rows = Array.isArray(customers) ? customers : [];
  if (!rows.length) return rows;
  const [grouped, plans] = await Promise.all([
    loadSubsByPhone(rows),
    loadPlans(rows.filter(hasMembership)),
  ]);
  for (const row of rows) {
    if (!hasMembership(row)) {
      row.membershipExpired = false;
      row.membershipEndDate = null;
      continue;
    }
    const subs = matchingSubs(row, grouped.get(last10(row.mobile)) || []);
    const fromSub = verdictFromSubs(subs);
    const verdict = fromSub.known ? fromSub : verdictFromPurchase(row, planFor(row, plans));
    row.membershipExpired = verdict.expired;
    row.membershipEndDate = verdict.endDate || null;
  }
  return rows;
};

export const MEMBERSHIP_EXPIRED_MESSAGE =
  'This membership has expired. Membership discount, cashback, and other membership benefits cannot be applied.';

import Membership from '../models/membership.model.js';

const DEFAULT_THEME_BY_PLAN_ID = {
  general: 'blue',
  special: 'purple',
  junior: 'green',
  premium: 'orange',
  pro: 'orange',
};

const DEFAULT_ICON_BY_PLAN_ID = {
  general: 'user',
  special: 'star',
  junior: 'graduation',
  premium: 'crown',
  pro: 'crown',
};

const toPlainUsageLimits = usageLimits => {
  if (!usageLimits) return {};
  if (usageLimits instanceof Map) {
    return Object.fromEntries(usageLimits.entries());
  }
  if (Array.isArray(usageLimits)) {
    return Object.fromEntries(usageLimits);
  }
  if (typeof usageLimits?.toJSON === 'function') {
    const json = usageLimits.toJSON();
    if (json && typeof json === 'object' && json !== usageLimits) {
      return toPlainUsageLimits(json);
    }
  }
  if (typeof usageLimits === 'object') return usageLimits;
  return {};
};

const readLimitField = (row, field) => {
  if (row == null || typeof row !== 'object') return 0;
  const n = Number(row[field]);
  return Number.isFinite(n) ? n : 0;
};

const findUsageLimitValue = (usageLimits, matchers, field) => {
  const entries = Object.entries(toPlainUsageLimits(usageLimits));
  for (const [key, value] of entries) {
    const normalized = String(key || '').trim().toLowerCase();
    if (matchers.some(m => normalized === m || normalized.includes(m))) {
      const n = readLimitField(value, field);
      if (n > 0) return n;
    }
  }
  return 0;
};

const resolveCategoryDiscount = (displayValue, usageLimits, matchers) => {
  const fromDisplay = Number(displayValue ?? 0);
  if (Number.isFinite(fromDisplay) && fromDisplay > 0) return fromDisplay;
  return Math.max(0, findUsageLimitValue(usageLimits, matchers, 'discount'));
};

const resolveCategoryCashback = (displayValue, usageLimits, matchers) => {
  const fromDisplay = Number(displayValue ?? 0);
  if (Number.isFinite(fromDisplay) && fromDisplay > 0) return fromDisplay;
  return Math.max(0, findUsageLimitValue(usageLimits, matchers, 'cashback'));
};

const isPremiumMembership = membership => {
  const planId = String(membership?.planId || '').trim().toLowerCase();
  const name = String(membership?.displayName || '').trim().toLowerCase();
  return planId === 'premium' || name === 'premium' || name.includes('premium');
};

export const getListedPlanPrice = membership => {
  const amount = Number(membership?.pricing?.amount ?? 0);
  if (!Number.isFinite(amount) || amount < 0) return 0;
  return amount;
};

export const getMembershipPlanByPlanId = async planId => {
  const normalized = String(planId || '').trim().toLowerCase();
  if (!normalized) return null;
  return Membership.findOne({
    planId: normalized,
    status: 'Active',
  }).lean();
};

export const getMembershipOrderAmount = async planId => {
  const plan = await getMembershipPlanByPlanId(planId);
  if (!plan) return null;
  return getListedPlanPrice(plan);
};

export const assertActiveMembershipPlan = async planId => {
  const plan = await getMembershipPlanByPlanId(planId);
  if (!plan) {
    const error = new Error('Select a valid membership plan');
    error.status = 400;
    throw error;
  }
  return plan;
};

export const resolvePlanMeta = membership => {
  const planId = String(membership?.planId || '').toLowerCase();
  const display = membership?.customerDisplay || {};
  return {
    label: `${membership?.displayName || planId} Membership`,
    validity:
      String(display.badgeLabel || membership?.pricing?.period || 'Yearly').trim() ||
      'Yearly',
    planId,
    membershipPlanId: membership?._id || null,
  };
};

export const formatCustomerMembershipPlan = membership => {
  const planId = String(membership.planId || '').trim().toLowerCase();
  const display = membership.customerDisplay || {};
  const usageLimits = toPlainUsageLimits(membership.usageLimits);
  const price = getListedPlanPrice(membership);

  const storeDiscount = resolveCategoryDiscount(
    display.storeDiscountPercent,
    usageLimits,
    ['products', 'product', 'store', 'supply'],
  );
  const spaceDiscount = resolveCategoryDiscount(
    display.spaceDiscountPercent,
    usageLimits,
    ['space', 'spaces', 'booking'],
  );
  const foodDiscount = resolveCategoryDiscount(
    display.foodDiscountPercent,
    usageLimits,
    ['food', 'foods', 'meal', 'canteen'],
  );
  const serviceDiscount = resolveCategoryDiscount(
    display.serviceDiscountPercent,
    usageLimits,
    ['services', 'service'],
  );

  const foodCashback = resolveCategoryCashback(
    display.cashbackPercent,
    usageLimits,
    ['food', 'foods', 'meal', 'canteen'],
  );
  const storeCashback = resolveCategoryCashback(
    display.storeCashbackPercent,
    usageLimits,
    ['products', 'product', 'store', 'supply'],
  );
  const spaceCashback = resolveCategoryCashback(0, usageLimits, [
    'space',
    'spaces',
    'booking',
  ]);
  const serviceCashback = resolveCategoryCashback(0, usageLimits, [
    'services',
    'service',
  ]);

  const cashbackPercent =
    Number(display.cashbackPercent ?? 0) ||
    findUsageLimitValue(
      usageLimits,
      ['store', 'product', 'products', 'general', 'space', 'food', 'service', 'services'],
      'cashback',
    );

  const features = Array.isArray(display.features) && display.features.length
    ? display.features.map(item => ({
        label: String(item.label || '').trim(),
        was: Number(item.was ?? 0) || undefined,
      })).filter(item => item.label)
    : membership.description
      ? [{label: String(membership.description).trim(), was: price > 0 ? price * 4 : undefined}]
      : [];

  const themeKey =
    String(display.themeKey || DEFAULT_THEME_BY_PLAN_ID[planId] || 'blue').trim() || 'blue';
  const iconKey =
    String(display.iconKey || DEFAULT_ICON_BY_PLAN_ID[planId] || 'user').trim() || 'user';

  const badge =
    String(display.badgeLabel || membership.pricing?.period || 'Yearly').trim() || 'Yearly';
  const grossAmount = Number(membership.pricing?.grossAmount ?? 0);
  const listedGross = Number.isFinite(grossAmount) && grossAmount > 0 ? grossAmount : price;
  const discountAmount = Math.max(0, listedGross - price);
  const walletCashbackAmount = Math.max(
    0,
    Number(membership.walletCashback?.amount ?? 0) || 0,
  );
  const cspEligible = isPremiumMembership(membership);

  const categories = [
    {
      key: 'food',
      icon: 'food',
      label: 'Food',
      discountPercent: foodDiscount,
      cashbackPercent: foodCashback,
    },
    {
      key: 'space',
      icon: 'space',
      label: 'Space',
      discountPercent: spaceDiscount,
      cashbackPercent: spaceCashback,
    },
    {
      key: 'products',
      icon: 'store',
      label: 'Products',
      discountPercent: storeDiscount,
      cashbackPercent: storeCashback,
    },
    {
      key: 'services',
      icon: 'service',
      label: 'Services',
      discountPercent: serviceDiscount,
      cashbackPercent: serviceCashback,
    },
  ];

  return {
    id: planId,
    planId,
    _id: membership._id,
    title: membership.displayName,
    badge,
    tenure: badge,
    price,
    grossAmount: listedGross,
    discountAmount,
    walletCashbackAmount,
    description: String(membership.description || '').trim(),
    themeKey,
    iconKey,
    features,
    discounts: [
      {icon: 'store', label: `Products ${storeDiscount}%`},
      {icon: 'service', label: `Services ${serviceDiscount}%`},
      {icon: 'food', label: `Food ${foodDiscount}%`},
      {icon: 'space', label: `Space ${spaceDiscount}%`},
    ],
    categories,
    cashback: `${cashbackPercent || 0}%`,
    cspEligible,
    programs: [
      {
        key: 'CSP',
        label: 'CSP',
        subtitle: 'Sell Products',
        eligible: cspEligible,
      },
      {
        key: 'HAP',
        label: 'HAP',
        subtitle: 'Refer & Earn',
        eligible: true,
      },
      {
        key: 'CVP',
        label: 'CVP',
        subtitle: 'Event Volunteering',
        eligible: true,
      },
    ],
    priority: Number(membership.priority ?? 0),
  };
};

export const getActiveCustomerMembershipPlans = async () => {
  const memberships = await Membership.find({status: 'Active'})
    .sort({priority: 1, createdAt: 1})
    .lean();

  return memberships
    .filter(plan => plan.customerDisplay?.showInApp === true)
    .map(formatCustomerMembershipPlan);
};

import mongoose from 'mongoose';
import Invoice from '../../../models/invoice.model.js';
import {normalizeMobile} from '../utils/normalize.js';

const toNum = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Build phone variants so invoice.customerPhone matches customer.mobile */
function phoneLookupVariants(mobile) {
  const raw = String(mobile ?? '').trim();
  const normalized = normalizeMobile(raw);
  const digits = normalized || raw.replace(/\D/g, '');
  const last10 = digits.length >= 10 ? digits.slice(-10) : digits;
  if (!last10) return {variants: [], last10: ''};

  const variants = new Set(
    [
      raw,
      normalized,
      digits,
      last10,
      `+91${last10}`,
      `91${last10}`,
      `0${last10}`,
      `${last10.slice(0, 5)} ${last10.slice(5)}`,
      `${last10.slice(0, 5)}-${last10.slice(5)}`,
    ].filter(Boolean),
  );

  return {variants: [...variants], last10};
}

function buildCustomerInvoiceQuery(customerId, customerMobile) {
  const or = [];

  const id = String(customerId ?? '').trim();
  if (id && mongoose.Types.ObjectId.isValid(id)) {
    const oid = new mongoose.Types.ObjectId(id);
    or.push({customerId: oid});
    or.push({customerId: id});
  }

  const {variants, last10} = phoneLookupVariants(customerMobile);
  if (variants.length) {
    or.push({customerPhone: {$in: variants}});
  }
  if (last10.length === 10) {
    or.push({customerPhone: {$regex: `${last10}$`}});
  }

  if (!or.length) {
    return null;
  }

  return {
    $or: or,
    status: {$ne: 'draft'},
  };
}

const mapPaymentStatus = inv => {
  const doc = String(inv.status || '').toLowerCase();
  if (doc === 'cancelled') return 'Cancelled';
  if (doc === 'draft') return 'Draft';

  const due = toNum(inv.pendingAmount ?? inv.paymentBreakdown?.dueAmount);
  const ps = String(inv.paymentStatus || '').toLowerCase();
  if (due > 0.001 || ps === 'partial' || ps === 'due') return 'Pending';
  return 'Paid';
};

function resolvePaidAmount(inv) {
  return toNum(
    inv.paymentBreakdown?.paidAmount ??
      toNum(inv.paymentBreakdown?.cash) +
        toNum(inv.paymentBreakdown?.upi) +
        toNum(inv.paymentBreakdown?.card) +
        toNum(inv.paymentBreakdown?.wallet),
  );
}

/** Bill total vs. what has actually been collected so far (partial / due invoices). */
function resolveSettlement(inv) {
  const grandTotal = toNum(inv.grandTotal) || resolvePaidAmount(inv);
  const pendingAmount = Math.max(
    0,
    Math.round(toNum(inv.pendingAmount ?? inv.paymentBreakdown?.dueAmount) * 100) / 100,
  );
  const amountPaid = Math.max(0, Math.round((grandTotal - pendingAmount) * 100) / 100);
  return {grandTotal, pendingAmount, amountPaid};
}

function resolveBenefitBreakdown(inv) {
  const discountAmount = toNum(inv.discountTotal);
  const cashbackAmount = toNum(inv.cashbackTotal);
  const totalBenefit =
    Math.round((discountAmount + cashbackAmount) * 100) / 100;

  return {discountAmount, cashbackAmount, totalBenefit};
}

function resolveCategory(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return 'GENERAL';

  const counts = new Map();
  for (const item of list) {
    const label = String(item.category || 'General').trim() || 'General';
    counts.set(label, (counts.get(label) || 0) + toNum(item.qty || 0));
  }

  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  return String(top || 'General').toUpperCase();
}

function resolveItemCount(items) {
  return (Array.isArray(items) ? items : []).reduce(
    (sum, item) => sum + toNum(item.qty || 0),
    0,
  );
}

/** PIN-verified staff who billed the invoice (fallback: sales person). */
function resolveBilledBy(inv) {
  const invoiceBy =
    inv?.invoiceBy && typeof inv.invoiceBy === 'object' ? inv.invoiceBy : {};
  const name = String(
    invoiceBy.staffName || invoiceBy.name || inv.salesPersonName || '',
  ).trim();
  if (!name) return null;
  return {
    staffId: invoiceBy.staffId ? String(invoiceBy.staffId) : null,
    staffName: name,
    employeeId: String(invoiceBy.employeeId || '').trim() || null,
    email: String(invoiceBy.email || '').trim() || null,
  };
}

/** Transaction History list row — matches customer portal table UI */
const mapActivityListItem = inv => {
  const items = Array.isArray(inv.items) ? inv.items : [];
  const itemCount = resolveItemCount(items);
  const subTotal = toNum(inv.subTotal);
  const totalPaid = toNum(inv.grandTotal) || resolvePaidAmount(inv);
  const {discountAmount, cashbackAmount, totalBenefit} =
    resolveBenefitBreakdown(inv);
  const category = resolveCategory(items);
  const {grandTotal, pendingAmount, amountPaid} = resolveSettlement(inv);

  return {
    invoiceId: String(inv._id),
    invoiceNumber: inv.invoiceCode || '',
    createdAt: inv.createdAt,
    grandTotal,
    amountPaid,
    pendingAmount,
    billedBy: resolveBilledBy(inv),
    /** Bill value before benefits (shown as PAID column in design) */
    subTotal,
    /** Actual amount customer paid at checkout */
    totalPaid,
    category,
    paidAmount: subTotal,
    itemCount,
    totalBenefit,
    benefited: totalBenefit,
    discountAmount,
    cashbackAmount,
    status: mapPaymentStatus(inv),
  };
};

const activitySelectFields =
  'invoiceCode subTotal discountTotal membershipDiscount cashbackTotal grandTotal status paymentStatus pendingAmount paymentBreakdown coupon referral items mode createdAt customerId customerPhone invoiceBy salesPersonName';

/** Invoice Receipt modal — full breakdown for one transaction */
const mapActivityDetail = inv => {
  const items = Array.isArray(inv.items) ? inv.items : [];
  const itemCount = resolveItemCount(items);
  const subTotal = toNum(inv.subTotal);
  const totalPaid = toNum(inv.grandTotal) || resolvePaidAmount(inv);
  const {discountAmount, cashbackAmount, totalBenefit} =
    resolveBenefitBreakdown(inv);
  const {grandTotal, amountPaid} = resolveSettlement(inv);

  return {
    invoiceId: String(inv._id),
    invoiceNumber: inv.invoiceCode || '',
    grandTotal,
    amountPaid,
    itemCount,
    category: resolveCategory(items),
    dateTime: inv.createdAt,
    createdAt: inv.createdAt,
    status: mapPaymentStatus(inv),
    subTotal,
    subtotal: subTotal,
    discount: discountAmount,
    discountAmount,
    cashback: cashbackAmount,
    cashbackAmount,
    totalPaid,
    paidAmount: totalPaid,
    totalBenefit,
    benefited: totalBenefit,
    paymentMode: inv.mode || '',
    pendingAmount: toNum(inv.pendingAmount ?? inv.paymentBreakdown?.dueAmount),
    billedBy: resolveBilledBy(inv),
    items: items.map(item => ({
      productName: item.productName || '',
      qty: toNum(item.qty),
      unitPrice: toNum(item.unitPrice),
      discount: toNum(item.discount),
      lineTotal: toNum(item.lineTotal),
      category: String(item.category || 'General').toUpperCase(),
    })),
  };
};

/**
 * Customer portal activity = invoices for this customer.
 */
export async function getCustomerActivity(
  customerId,
  {page = 1, limit = 20, status, customerMobile} = {},
) {
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(100, Math.max(1, Number(limit) || 20));
  const skip = (pageNum - 1) * limitNum;

  const query = buildCustomerInvoiceQuery(customerId, customerMobile);
  if (!query) {
    return {
      activities: [],
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: 0,
        totalPages: 1,
      },
    };
  }

  const [rows, total] = await Promise.all([
    Invoice.find(query)
      .sort({createdAt: -1})
      .skip(skip)
      .limit(limitNum)
      .select(activitySelectFields)
      .lean(),
    Invoice.countDocuments(query),
  ]);

  let activities = rows.map(mapActivityListItem);
  if (status) {
    const s = String(status).toLowerCase();
    activities = activities.filter(a => a.status.toLowerCase() === s);
  }

  return {
    activities,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      totalPages: Math.ceil(total / limitNum) || 1,
    },
  };
}

/**
 * Single invoice receipt for customer portal (tap row → detail modal).
 */
export async function getCustomerActivityDetail(
  customerId,
  invoiceId,
  {customerMobile} = {},
) {
  const customerQuery = buildCustomerInvoiceQuery(customerId, customerMobile);
  if (!customerQuery || !mongoose.Types.ObjectId.isValid(String(invoiceId))) {
    return null;
  }

  const inv = await Invoice.findOne({
    _id: invoiceId,
    ...customerQuery,
  })
    .select(activitySelectFields)
    .lean();

  if (!inv) return null;
  return mapActivityDetail(inv);
}

export async function getCustomerActivityInsights(
  customerId,
  {customerMobile} = {},
) {
  const empty = {
    impact: {
      totalBenefited: 0,
      totalCashback: 0,
      totalDiscount: 0,
      rewardsCount: 0,
    },
    activities: {
      shopping: {count: 0, benefit: 0},
      services: {count: 0, benefit: 0},
      space: {count: 0, benefit: 0},
      food: {count: 0, benefit: 0},
    },
  };

  const match = buildCustomerInvoiceQuery(customerId, customerMobile);
  if (!match) return empty;

  const rows = await Invoice.aggregate([
    {$match: match},
    {
      $addFields: {
        uiCategory: {
          $let: {
            vars: {
              topItemCategory: {
                $ifNull: [{$arrayElemAt: ['$items.category', 0]}, ''],
              },
            },
            in: {
              $switch: {
                branches: [
                  {
                    case: {
                      $regexMatch: {
                        input: {$toUpper: '$$topItemCategory'},
                        regex: 'SERVICE',
                      },
                    },
                    then: 'services',
                  },
                  {
                    case: {
                      $regexMatch: {
                        input: {$toUpper: '$$topItemCategory'},
                        regex: 'SPACE',
                      },
                    },
                    then: 'space',
                  },
                  {
                    case: {
                      $regexMatch: {
                        input: {$toUpper: '$$topItemCategory'},
                        regex: 'FOOD|CAFE',
                      },
                    },
                    then: 'food',
                  },
                ],
                default: 'shopping',
              },
            },
          },
        },
        discountAmount: {$ifNull: ['$discountTotal', 0]},
        cashbackAmount: {$ifNull: ['$cashbackTotal', 0]},
      },
    },
    {
      $addFields: {
        benefit: {$add: ['$discountAmount', '$cashbackAmount']},
      },
    },
    {
      $facet: {
        impact: [
          {
            $group: {
              _id: null,
              totalBenefited: {$sum: '$benefit'},
              totalCashback: {$sum: '$cashbackAmount'},
              totalDiscount: {$sum: '$discountAmount'},
              rewardsCount: {$sum: 1},
            },
          },
        ],
        byCategory: [
          {
            $group: {
              _id: '$uiCategory',
              count: {$sum: 1},
              benefit: {$sum: '$benefit'},
            },
          },
        ],
      },
    },
  ]);

  const impactRow = rows[0]?.impact?.[0] ?? {};
  const byCategory = rows[0]?.byCategory ?? [];

  const catMap = {
    shopping: {count: 0, benefit: 0},
    services: {count: 0, benefit: 0},
    space: {count: 0, benefit: 0},
    food: {count: 0, benefit: 0},
  };

  for (const row of byCategory) {
    if (catMap[row._id]) {
      catMap[row._id] = {
        count: row.count,
        benefit: Math.round((row.benefit ?? 0) * 100) / 100,
      };
    }
  }

  return {
    impact: {
      totalBenefited: Math.round((impactRow.totalBenefited ?? 0) * 100) / 100,
      totalCashback: Math.round((impactRow.totalCashback ?? 0) * 100) / 100,
      totalDiscount: Math.round((impactRow.totalDiscount ?? 0) * 100) / 100,
      rewardsCount: impactRow.rewardsCount ?? 0,
    },
    activities: catMap,
  };
}

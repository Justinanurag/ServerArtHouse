import Invoice from '../models/invoice.model.js';
import Subscription from '../models/subscription.model.js';
import Customer from '../models/customer.model.js';
import Vendor from '../models/vendor.model.js';
import CustomersailorProgram from '../models/customerSellerProgram.model.js';
import Purchase from '../models/purchase.model.js';
import Expence from '../models/expence.model.js';

const PERIODS = new Set(['today', 'this_month', 'last_month', 'lifetime']);

/** Local calendar YYYY-MM-DD (server local / IST-friendly without UTC shift). */
const toYmd = date => {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const startOfDay = ymd => {
  const d = new Date(`${ymd}T00:00:00.000`);
  return Number.isNaN(d.getTime()) ? null : d;
};

const endOfDay = ymd => {
  const d = new Date(`${ymd}T23:59:59.999`);
  return Number.isNaN(d.getTime()) ? null : d;
};

const resolvePeriodRange = (periodRaw, fromRaw, toRaw) => {
  const period = String(periodRaw || 'today')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  const fromQ = String(fromRaw || '').trim();
  const toQ = String(toRaw || '').trim();
  if (fromQ || toQ) {
    return {
      period: PERIODS.has(period) ? period : 'custom',
      fromDate: fromQ || null,
      toDate: toQ || null,
      from: fromQ ? startOfDay(fromQ) : null,
      to: toQ ? endOfDay(toQ) : null,
    };
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayYmd = toYmd(today);

  if (period === 'lifetime' || period === 'all') {
    return {period: 'lifetime', fromDate: null, toDate: null, from: null, to: null};
  }

  if (period === 'this_month' || period === 'month') {
    const from = new Date(today.getFullYear(), today.getMonth(), 1);
    return {
      period: 'this_month',
      fromDate: toYmd(from),
      toDate: todayYmd,
      from: startOfDay(toYmd(from)),
      to: endOfDay(todayYmd),
    };
  }

  if (period === 'last_month') {
    const first = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const last = new Date(today.getFullYear(), today.getMonth(), 0);
    return {
      period: 'last_month',
      fromDate: toYmd(first),
      toDate: toYmd(last),
      from: startOfDay(toYmd(first)),
      to: endOfDay(toYmd(last)),
    };
  }

  // today (default)
  return {
    period: 'today',
    fromDate: todayYmd,
    toDate: todayYmd,
    from: startOfDay(todayYmd),
    to: endOfDay(todayYmd),
  };
};

const dateQuery = (field, from, to) => {
  if (!from && !to) return {};
  const range = {};
  if (from) range.$gte = from;
  if (to) range.$lte = to;
  return {[field]: range};
};

const orDateQuery = (fields, from, to) => {
  if (!from && !to) return {};
  return {
    $or: fields.map(field => dateQuery(field, from, to)),
  };
};

const normalizeLineBucket = raw => {
  const lower = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!lower) return 'Store';
  if (/membership|subscription/.test(lower)) return 'Membership';
  if (lower.includes('space') || lower.includes('studio')) return 'Space';
  if (lower.includes('service')) return 'Services';
  if (lower.includes('food') || lower.includes('cafe') || lower.includes('snack')) {
    return 'Food';
  }
  return 'Store';
};

const emptyRevenue = () => ({
  Store: 0,
  Space: 0,
  Services: 0,
  Food: 0,
  Membership: 0,
  total: 0,
});

const membershipAbbrev = label => {
  const raw = String(label || '')
    .trim()
    .toLowerCase();
  if (!raw || raw === 'none' || raw === 'visitor') return null;
  if (raw.includes('special') || raw === 'sp') return 'SP';
  if (raw.includes('premium') || raw === 'pm') return 'PM';
  if (raw.includes('junior') || raw.includes('junoir') || raw === 'jm') return 'JM';
  if (raw.includes('elite') || raw.includes('platinum') || raw === 'cm' || raw.includes('corporate')) {
    return 'CM';
  }
  if (raw.includes('general') || raw.includes('gold') || raw === 'gm') return 'GM';
  if (raw.includes('silver') || raw === 'sm') return 'SM';
  const letters = raw.replace(/[^a-z]/g, '');
  return (letters.slice(0, 2) || 'XX').toUpperCase();
};

/** Same amount rule as SubscriptionScreen footer (grandTotal ?? amount). */
const subscriptionReceived = sub => {
  const status = String(sub.status ?? '').toLowerCase();
  // Not real revenue — drafts never billed; cancelled refunded/voided
  if (status === 'cancelled' || status === 'draft') return 0;
  const n = Number(sub.grandTotal ?? sub.amount ?? 0);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
};

/**
 * GET /dashboard/summary?period=today|this_month|last_month|lifetime
 * Optional: &fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD
 */
export const getDashboardSummary = async (req, res) => {
  try {
    const range = resolvePeriodRange(
      req.query.period,
      req.query.fromDate,
      req.query.toDate,
    );
    const {from, to, period, fromDate, toDate} = range;

    const invoiceDateFilter = orDateQuery(['invoiceDate', 'createdAt'], from, to);
    // Match GET /subscriptions: membership revenue is keyed only on invoiceDate
    const subscriptionDateFilter = dateQuery('invoiceDate', from, to);
    const customerDateFilter = dateQuery('createdAt', from, to);
    const vendorDateFilter = dateQuery('createdAt', from, to);
    const cspDateFilter = dateQuery('createdAt', from, to);
    const purchaseDateFilter = orDateQuery(['invoiceDate', 'createdAt'], from, to);
    // Match GET /expences: expenses list filters on `date` only (not createdAt)
    const expenseDateFilter = dateQuery('date', from, to);

    const [
      invoices,
      subscriptions,
      customerCount,
      vendorCount,
      cspCount,
      purchases,
      expenses,
      membershipCustomers,
    ] = await Promise.all([
      Invoice.find({
        ...invoiceDateFilter,
        status: {$nin: ['Cancelled', 'cancelled', 'Draft', 'draft']},
      })
        .select('grandTotal returnedAmount status items invoiceDate createdAt')
        .lean(),
      Subscription.find({
        ...subscriptionDateFilter,
        status: {$nin: ['Cancelled', 'cancelled', 'Draft', 'draft']},
      })
        .select(
          'grandTotal amount status membershipType membershipPlan planId invoiceDate startDate createdAt',
        )
        .lean(),
      Customer.countDocuments(customerDateFilter),
      Vendor.countDocuments(vendorDateFilter),
      CustomersailorProgram.countDocuments({
        ...cspDateFilter,
        status: 'active',
      }),
      Purchase.find(purchaseDateFilter)
        .select('grandTotal amount invoiceDate createdAt')
        .lean(),
      Expence.find({
        ...expenseDateFilter,
        status: {$ne: 'Cancelled'},
      })
        .select('amount status date createdAt')
        .lean(),
      // For membership breakdown prefer period subscriptions; fallback customers if none
      Customer.find({
        ...customerDateFilter,
        membershipType: {$exists: true, $nin: [null, '', 'none', 'None']},
      })
        .select('membershipType')
        .lean(),
    ]);

    // console.log({
    //   subscriptions,
    // })

    const revenue = emptyRevenue();
    for (const invoice of invoices) {
      const amount = Math.max(
        0,
        Number(invoice.grandTotal ?? 0) - Number(invoice.returnedAmount ?? 0),
      );
      if (!(amount > 0)) continue;
      const items = Array.isArray(invoice.items) ? invoice.items : [];
      if (items.length === 0) {
        revenue.Store += amount;
        continue;
      }
      const lineTotals = items.map(item => {
        const direct = Number(item.lineTotal ?? 0);
        if (Number.isFinite(direct) && direct > 0) return direct;
        return Math.max(
          0,
          Number(item.qty ?? 1) * Number(item.unitPrice ?? item.price ?? 0) -
            Number(item.discount ?? 0),
        );
      });
      const sumLines = lineTotals.reduce((a, b) => a + b, 0);
      if (!(sumLines > 0)) {
        revenue.Store += amount;
        continue;
      }
      items.forEach((item, idx) => {
        const bucket = normalizeLineBucket(
          item.category || item.lineCategory || item.sourceType || item.productName,
        );
        // Skip POS membership lines — counted from Subscription table
        if (bucket === 'Membership') return;
        const share = (lineTotals[idx] / sumLines) * amount;
        revenue[bucket] += share;
      });
    }

    // Membership revenue from subscriptions in period (invoiceDate only — same as /subscriptions)
    revenue.Membership = 0;
    const membershipByCode = new Map();
    let membershipCount = 0;
    for (const sub of subscriptions) {
      const received = subscriptionReceived(sub);
      revenue.Membership += received;
      membershipCount += 1;
      const code =
        membershipAbbrev(sub.membershipType) ||
        membershipAbbrev(sub.planId) ||
        membershipAbbrev(sub.membershipPlan) ||
        'XX';
      membershipByCode.set(code, (membershipByCode.get(code) || 0) + 1);
    }

    // If no subscriptions in range but customers were created with plans, show those
    if (membershipCount === 0 && membershipCustomers.length > 0) {
      for (const c of membershipCustomers) {
        const code = membershipAbbrev(c.membershipType);
        if (!code) continue;
        membershipCount += 1;
        membershipByCode.set(code, (membershipByCode.get(code) || 0) + 1);
      }
    }

    revenue.total =
      revenue.Store +
      revenue.Space +
      revenue.Services +
      revenue.Food +
      revenue.Membership;

    const purchaseTotal = purchases.reduce(
      (sum, row) => sum + Number(row.grandTotal ?? row.amount ?? 0),
      0,
    );
    // Match Expenses page "Total" — bill amount, not paidAmount
    const expenseTotal = expenses.reduce(
      (sum, row) => sum + (Number(row.amount) || 0),
      0,
    );

    const membershipBreakdown = [...membershipByCode.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([code, count]) => ({code, count}));

    return res.status(200).json({
      success: true,
      period,
      fromDate,
      toDate,
      data: {
        revenue: {
          total: Math.round(revenue.total * 100) / 100,
          store: Math.round(revenue.Store * 100) / 100,
          space: Math.round(revenue.Space * 100) / 100,
          services: Math.round(revenue.Services * 100) / 100,
          food: Math.round(revenue.Food * 100) / 100,
          membership: Math.round(revenue.Membership * 100) / 100,
        },
        membership: {
          total: membershipCount,
          breakdown: membershipBreakdown,
        },
        network: {
          total: customerCount + vendorCount + cspCount,
          customers: customerCount,
          vendors: vendorCount,
          csp: cspCount,
        },
        purchaseExpense: {
          total: Math.round((purchaseTotal + expenseTotal) * 100) / 100,
          purchase: Math.round(purchaseTotal * 100) / 100,
          expense: Math.round(expenseTotal * 100) / 100,
        },
      },
    });
  } catch (error) {
    console.error('getDashboardSummary error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to load dashboard summary.',
    });
  }
};

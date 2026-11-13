import Invoice from '../models/invoice.model.js';
import SpaceBooking from '../models/spaceBooking.model.js';
import Food from '../models/food.model.js';
import Product from '../models/product.model.js';
import Space from '../models/space.model.js';
import {
  isMembershipPurchaseLine,
  normalizeLineType,
} from '../utils/itemClassification.utils.js';

/**
 * Net sales for Insights.
 * A final invoice counts once. Drafts and cancellations do not.
 * Revenue is grandTotal minus returns, then shared across Food, Space, and
 * Store by each line's value. Membership-plan lines are not sales.
 * A space booking is not added again when its invoice is already counted.
 * Collected cash, wallet top-ups, and cashback are not revenue.
 */

const TZ = 'Asia/Kolkata';
const PERIODS = [
  {key: 'morning', label: 'Morning', hint: '6:00 AM – 12:00 PM'},
  {key: 'afternoon', label: 'Afternoon', hint: '12:00 PM – 4:00 PM'},
  {key: 'evening', label: 'Evening', hint: '4:00 PM – 8:00 PM'},
  {key: 'night', label: 'Night', hint: '8:00 PM – 6:00 AM'},
];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const SEGMENT_META = {
  food: {key: 'food', label: 'Food', noun: 'food items'},
  space: {key: 'space', label: 'Space', noun: 'bookings'},
  store: {key: 'store', label: 'Store', noun: 'products'},
};

const cache = new Map();
const CACHE_MS = 20000;

const roundMoney = value => Math.round((Number(value) || 0) * 100) / 100;

const istYmd = (date = new Date()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);

const addDays = (ymd, days) => {
  const [year, month, day] = String(ymd).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

const inclusiveDays = (from, to) => {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const start = Date.UTC(fy, fm - 1, fd);
  const end = Date.UTC(ty, tm - 1, td);
  return Math.floor((end - start) / 86400000) + 1;
};

const bounds = (from, to) => ({
  from,
  to,
  start: new Date(`${from}T00:00:00.000+05:30`),
  end: new Date(`${to}T23:59:59.999+05:30`),
});

export const resolveInsightsRange = query => {
  const preset = String(query.preset || query.period || 'today').trim();
  const today = istYmd();
  let from = today;
  let to = today;

  if (preset === 'yesterday') {
    from = to = addDays(today, -1);
  } else if (preset === 'last7') {
    from = addDays(today, -6);
  } else if (preset === 'last30') {
    from = addDays(today, -29);
  } else if (preset === 'thisMonth') {
    from = `${today.slice(0, 8)}01`;
  } else if (preset === 'lastMonth') {
    const firstThis = `${today.slice(0, 8)}01`;
    to = addDays(firstThis, -1);
    from = `${to.slice(0, 8)}01`;
  } else if (preset === 'year') {
    from = `${today.slice(0, 4)}-01-01`;
  } else if (preset === 'custom') {
    from = String(query.from || query.startDate || '').trim();
    to = String(query.to || query.endDate || '').trim();
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
    return {error: 'Choose a valid date range.'};
  }

  const days = inclusiveDays(from, to);
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  return {
    preset: preset === 'custom' ? 'custom' : preset || 'today',
    current: bounds(from, to),
    previous: bounds(prevFrom, prevTo),
    days,
  };
};

const segmentOf = category => {
  if (isMembershipPurchaseLine(category)) return null;
  const type = normalizeLineType(category);
  if (type === 'food') return 'food';
  if (type === 'space') return 'space';
  return 'store';
};

const isMemberInvoice = invoice => {
  const value = String(invoice.membershipType || '').trim().toLowerCase();
  return Boolean(value) && !['none', 'non-member', 'nonmember', 'regular'].includes(value);
};

const phoneKey = value => {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
};

const customerKeyOf = invoice => {
  if (invoice.customerId) return `id:${String(invoice.customerId)}`;
  const phone = phoneKey(invoice.customerPhone);
  if (phone) return `phone:${phone}`;
  const name = String(invoice.customerName || '').trim().toLowerCase();
  return name ? `name:${name}` : 'walkin';
};

const istParts = date => {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(part => [part.type, part.value]));
  const weekday = String(parts.weekday || 'Mon').slice(0, 3);
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    weekday: WEEKDAYS.includes(weekday) ? weekday : 'Mon',
  };
};

const isoWeekKey = ymd => {
  const [year, month, day] = ymd.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekDay = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekDay);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
};

const dayPeriod = hour => {
  if (hour >= 6 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 16) return 'afternoon';
  if (hour >= 16 && hour < 20) return 'evening';
  return 'night';
};

const changePct = (current, previous) => {
  if (!(previous > 0)) return current > 0 ? null : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
};

const invoiceMatch = range => ({
  status: 'final',
  invoiceDate: {$gte: range.start, $lte: range.end},
});

const invoiceCache = new Map();

const loadInvoices = range => {
  const key = `${range.from}|${range.to}`;
  const hit = invoiceCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const pending = Invoice.aggregate([
    {$match: invoiceMatch(range)},
    {
      $project: {
        invoiceCode: 1,
        invoiceDate: 1,
        createdAt: 1,
        customerId: 1,
        customerName: 1,
        customerPhone: 1,
        membershipType: 1,
        grandTotal: 1,
        returnedAmount: 1,
        items: {
          $map: {
            input: {$ifNull: ['$items', []]},
            as: 'item',
            in: {
              productName: '$$item.productName',
              qty: '$$item.qty',
              lineTotal: '$$item.lineTotal',
              category: '$$item.category',
            },
          },
        },
      },
    },
  ]).then(rows => {
    invoiceCache.set(key, {expires: Date.now() + CACHE_MS, value: rows});
    return rows;
  }).catch(error => {
    invoiceCache.delete(key);
    throw error;
  });
  invoiceCache.set(key, {expires: Date.now() + CACHE_MS, value: pending});
  return pending;
};

const allocateInvoice = invoice => {
  const net = roundMoney(Math.max(0, Number(invoice.grandTotal) - Number(invoice.returnedAmount || 0)));
  const lines = [];
  let lineSum = 0;
  for (const item of invoice.items || []) {
    const segment = segmentOf(item.category);
    if (!segment) continue;
    const lineTotal = Math.max(0, Number(item.lineTotal) || 0);
    lineSum += lineTotal;
    lines.push({
      segment,
      name: String(item.productName || 'Item').trim() || 'Item',
      qty: Math.max(0, Number(item.qty) || 0),
      lineTotal,
    });
  }
  if (!(net > 0) || !(lineSum > 0) || !lines.length) {
    return {net: 0, lines: [], member: isMemberInvoice(invoice)};
  }
  return {
    net,
    member: isMemberInvoice(invoice),
    lines: lines.map(line => ({
      ...line,
      revenue: roundMoney((line.lineTotal / lineSum) * net),
    })),
  };
};

const emptySegments = () => ({
  food: {revenue: 0, bills: 0, qty: 0, items: new Map()},
  space: {revenue: 0, bills: 0, qty: 0, items: new Map()},
  store: {revenue: 0, bills: 0, qty: 0, items: new Map()},
});

const addItem = (bucket, line, invoiceId) => {
  const key = line.name.toLowerCase();
  const row = bucket.get(key) || {name: line.name, qty: 0, revenue: 0, orders: new Set()};
  row.qty += line.qty;
  row.revenue = roundMoney(row.revenue + line.revenue);
  row.orders.add(String(invoiceId));
  bucket.set(key, row);
};

const passesFilters = (allocated, filters) => {
  if (filters.membership === 'member' && !allocated.member) return false;
  if (filters.membership === 'nonmember' && allocated.member) return false;
  if (filters.segment !== 'all') {
    return allocated.lines.some(line => line.segment === filters.segment && line.revenue > 0);
  }
  return allocated.lines.some(line => line.revenue > 0);
};

const rollup = (invoices, filters, {keepItems, keepCustomers, keepPeak}) => {
  const segments = emptySegments();
  const membership = {member: 0, other: 0, memberBills: 0, otherBills: 0};
  const periods = {morning: {bills: 0, revenue: 0}, afternoon: {bills: 0, revenue: 0}, evening: {bills: 0, revenue: 0}, night: {bills: 0, revenue: 0}};
  const weekdays = Object.fromEntries(WEEKDAYS.map(day => [day, {bills: 0, revenue: 0}]));
  const customers = new Map();
  let bills = 0;
  let revenue = 0;

  for (const invoice of invoices) {
    const allocated = allocateInvoice(invoice);
    if (!passesFilters(allocated, filters)) continue;
    const lines = filters.segment === 'all'
      ? allocated.lines
      : allocated.lines.filter(line => line.segment === filters.segment);
    const invoiceRevenue = roundMoney(lines.reduce((sum, line) => sum + line.revenue, 0));
    if (!(invoiceRevenue > 0)) continue;

    bills += 1;
    revenue = roundMoney(revenue + invoiceRevenue);
    if (allocated.member) {
      membership.member = roundMoney(membership.member + invoiceRevenue);
      membership.memberBills += 1;
    } else {
      membership.other = roundMoney(membership.other + invoiceRevenue);
      membership.otherBills += 1;
    }

    const seen = new Set();
    for (const line of lines) {
      if (!(line.revenue > 0) && !(line.qty > 0)) continue;
      const bucket = segments[line.segment];
      bucket.revenue = roundMoney(bucket.revenue + line.revenue);
      bucket.qty += line.qty;
      if (!seen.has(line.segment)) {
        bucket.bills += 1;
        seen.add(line.segment);
      }
      if (keepItems) addItem(bucket.items, line, invoice._id);
    }

    if (keepPeak) {
      const when = istParts(invoice.createdAt || invoice.invoiceDate);
      const period = dayPeriod(when.hour);
      periods[period].bills += 1;
      periods[period].revenue = roundMoney(periods[period].revenue + invoiceRevenue);
      weekdays[when.weekday].bills += 1;
      weekdays[when.weekday].revenue = roundMoney(weekdays[when.weekday].revenue + invoiceRevenue);
    }

    if (keepCustomers) {
      const key = customerKeyOf(invoice);
      const when = istParts(invoice.createdAt || invoice.invoiceDate);
      const row = customers.get(key) || {
        key,
        customerId: invoice.customerId ? String(invoice.customerId) : '',
        name: String(invoice.customerName || 'Walk-in').trim() || 'Walk-in',
        phone: phoneKey(invoice.customerPhone),
        spend: 0,
        bills: 0,
        days: new Set(),
        dayCounts: new Map(),
        weekCounts: new Map(),
        monthCounts: new Map(),
        firstVisit: when.day,
        lastVisit: when.day,
        member: false,
      };
      row.spend = roundMoney(row.spend + invoiceRevenue);
      row.bills += 1;
      row.days.add(when.day);
      row.dayCounts.set(when.day, (row.dayCounts.get(when.day) || 0) + 1);
      const week = isoWeekKey(when.day);
      const month = when.day.slice(0, 7);
      row.weekCounts.set(week, (row.weekCounts.get(week) || 0) + 1);
      row.monthCounts.set(month, (row.monthCounts.get(month) || 0) + 1);
      if (when.day < row.firstVisit) row.firstVisit = when.day;
      if (when.day > row.lastVisit) row.lastVisit = when.day;
      if (allocated.member) row.member = true;
      if (String(invoice.customerName || '').trim()) row.name = String(invoice.customerName).trim();
      customers.set(key, row);
    }
  }

  return {segments, membership, periods, weekdays, customers, bills, revenue};
};

const topRows = (bucket, limit = 30) =>
  [...bucket.values()]
    .map(row => ({
      name: row.name,
      qty: row.qty,
      revenue: roundMoney(row.revenue),
      orders: row.orders.size,
    }))
    .sort((a, b) => b.revenue - a.revenue || b.qty - a.qty)
    .slice(0, limit);

const looseName = value => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();

const spaceBase = value => looseName(String(value || '').split('(')[0].split('·')[0]);

const attachImages = async segments => {
  const foodNames = segments.food.map(row => row.name);
  const storeNames = segments.store.map(row => row.name);
  const [foods, products, spaces] = await Promise.all([
    foodNames.length
      ? Food.find({name: {$in: foodNames}}).select('name imageUrl').lean()
      : [],
    storeNames.length
      ? Product.find({productName: {$in: storeNames}}).select('productName itemCode imageUrl images').lean()
      : [],
    Space.find({}).select('name spaceCode imageUrl images').limit(400).lean(),
  ]);
  const foodImage = new Map(foods.map(row => [looseName(row.name), row.imageUrl || '']));
  const productInfo = new Map(products.map(row => [looseName(row.productName), {
    image: row.imageUrl || row.images?.[0] || '',
    sku: row.itemCode || '',
  }]));
  const spaceInfo = spaces.map(row => ({
    key: spaceBase(row.name),
    name: row.name,
    code: row.spaceCode || '',
    image: row.imageUrl || row.images?.[0] || '',
  }));

  const withFood = segments.food.map(row => ({...row, image: foodImage.get(looseName(row.name)) || ''}));
  const withStore = segments.store.map(row => {
    const info = productInfo.get(looseName(row.name));
    return {...row, image: info?.image || '', sku: info?.sku || ''};
  });
  const withSpace = segments.space.map(row => {
    const key = spaceBase(row.name);
    const info = spaceInfo.find(space => space.key && (space.key === key || key.startsWith(space.key) || space.key.startsWith(key)));
    return {...row, image: info?.image || '', sku: info?.code || ''};
  });
  return {food: withFood, store: withStore, space: withSpace};
};

const clockMinutes = value => {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
};

const bookingHours = booking => {
  const stored = Number(booking.durationHours) || 0;
  if (stored > 0) return stored;
  const start = clockMinutes(booking.startTime);
  const end = clockMinutes(booking.endTime);
  if (start == null || end == null || end <= start) return 0;
  return (end - start) / 60;
};

const loadSpaceStats = async range => {
  const rows = await SpaceBooking.find({
    status: {$in: ['Upcoming', 'Ongoing', 'Expired']},
    bookingDate: {$gte: range.start, $lte: range.end},
  })
    .select('spaceName durationHours startTime endTime')
    .lean();
  const byName = new Map();
  let bookings = 0;
  let hours = 0;
  for (const row of rows) {
    const span = bookingHours(row);
    bookings += 1;
    hours = roundMoney(hours + span);
    const key = spaceBase(row.spaceName);
    const current = byName.get(key) || {bookings: 0, hours: 0};
    current.bookings += 1;
    current.hours = roundMoney(current.hours + span);
    byName.set(key, current);
  }
  return {bookings, hours, byName};
};

const segmentPayload = (key, current, previous, days, spaceStats) => {
  const revenue = roundMoney(current.revenue);
  const prev = roundMoney(previous?.revenue || 0);
  const avg = current.bills > 0 ? roundMoney(revenue / current.bills) : 0;
  return {
    ...SEGMENT_META[key],
    revenue,
    share: 0,
    bills: current.bills,
    qty: current.qty,
    bookings: key === 'space' ? spaceStats.bookings : current.bills,
    hours: key === 'space' ? spaceStats.hours : 0,
    average: avg,
    previousRevenue: prev,
    changePct: changePct(revenue, prev),
  };
};

const priorCustomerKeys = async (customers, range) => {
  const ids = [];
  const phones = [];
  const names = [];
  for (const row of customers.values()) {
    if (row.key.startsWith('id:')) ids.push(row.customerId);
    else if (row.key.startsWith('phone:')) phones.push(row.phone);
    else if (row.key.startsWith('name:')) names.push(row.name);
  }
  const prior = new Set();
  const before = {status: 'final', invoiceDate: {$lt: range.start}};
  const [idHits, phoneHits, nameHits] = await Promise.all([
    ids.length
      ? Invoice.distinct('customerId', {...before, customerId: {$in: ids}})
      : [],
    phones.length
      ? Invoice.distinct('customerPhone', {
          ...before,
          customerId: null,
          customerPhone: {$in: phones.flatMap(phone => [phone, `91${phone}`, `+91${phone}`])},
        })
      : [],
    names.length
      ? Invoice.distinct('customerName', {
          ...before,
          customerId: null,
          customerPhone: {$in: ['', null]},
          customerName: {$in: names},
        })
      : [],
  ]);
  for (const id of idHits) prior.add(`id:${String(id)}`);
  for (const phone of phoneHits) {
    const key = phoneKey(phone);
    if (key) prior.add(`phone:${key}`);
  }
  for (const name of nameHits) prior.add(`name:${String(name || '').trim().toLowerCase()}`);
  return prior;
};

const visitorSummary = (customers, prior) => {
  let firstTime = 0;
  let repeat = 0;
  for (const row of customers.values()) {
    const visits = row.days.size;
    const returning = prior.has(row.key) || visits > 1;
    if (returning) repeat += 1;
    else firstTime += 1;
  }
  const unique = customers.size;
  const share = count => (unique > 0 ? Math.round((count / unique) * 1000) / 10 : 0);
  return {unique, firstTime, repeat, firstShare: share(firstTime), repeatShare: share(repeat)};
};

const readFilters = query => {
  const segment = String(query.segment || 'all').toLowerCase();
  const membership = String(query.membership || query.membershipType || 'all').toLowerCase();
  return {
    segment: ['food', 'space', 'store'].includes(segment) ? segment : 'all',
    membership: membership === 'member' || membership === 'membership'
      ? 'member'
      : membership === 'nonmember' || membership === 'non-membership'
        ? 'nonmember'
        : 'all',
  };
};

export const getInsights = async query => {
  const range = resolveInsightsRange(query);
  if (range.error) return {error: range.error};
  const filters = readFilters(query);
  const cacheKey = JSON.stringify({
    from: range.current.from,
    to: range.current.to,
    ...filters,
  });
  const hit = cache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.value;

  const pending = buildInsights(range, filters);
  cache.set(cacheKey, {expires: Date.now() + CACHE_MS, value: pending});
  try {
    const value = await pending;
    cache.set(cacheKey, {expires: Date.now() + CACHE_MS, value});
    return value;
  } catch (error) {
    cache.delete(cacheKey);
    throw error;
  }
};

const buildInsights = async (range, filters) => {
  const [currentInvoices, previousInvoices, spaceStats] = await Promise.all([
    loadInvoices(range.current),
    loadInvoices(range.previous),
    filters.segment === 'food' || filters.segment === 'store'
      ? Promise.resolve({bookings: 0, hours: 0, byName: new Map()})
      : loadSpaceStats(range.current),
  ]);

  const current = rollup(currentInvoices, filters, {keepItems: true, keepCustomers: true, keepPeak: true});
  const previous = rollup(previousInvoices, filters, {keepItems: false, keepCustomers: false, keepPeak: false});
  const prior = await priorCustomerKeys(current.customers, range.current);

  const items = {
    food: topRows(current.segments.food.items),
    space: topRows(current.segments.space.items).map(row => {
      const stats = spaceStats.byName.get(spaceBase(row.name));
      return {...row, bookings: stats?.bookings || row.orders, hours: stats?.hours || 0};
    }),
    store: topRows(current.segments.store.items),
  };
  const pictured = await attachImages(items);
  const total = roundMoney(current.revenue);
  const segments = ['food', 'space', 'store'].map(key => {
    const row = segmentPayload(key, current.segments[key], previous.segments[key], range.days, spaceStats);
    row.share = total > 0 ? Math.round((row.revenue / total) * 1000) / 10 : 0;
    row.top = pictured[key].slice(0, 3);
    return row;
  });

  const periodRows = PERIODS.map(period => ({
    ...period,
    bills: current.periods[period.key].bills,
    revenue: current.periods[period.key].revenue,
    share: current.bills > 0
      ? Math.round((current.periods[period.key].bills / current.bills) * 1000) / 10
      : 0,
  }));
  const busiest = [...periodRows].sort((a, b) => b.bills - a.bills || b.revenue - a.revenue)[0];
  const richest = [...periodRows].sort((a, b) => b.revenue - a.revenue || b.bills - a.bills)[0];
  const weekdayRows = WEEKDAYS.map(day => ({day, ...current.weekdays[day]}));
  const busiestDay = [...weekdayRows].sort((a, b) => b.bills - a.bills || b.revenue - a.revenue)[0];

  return {
    success: true,
    generatedAt: new Date().toISOString(),
    definition:
      'Net sales from final invoices, after discounts and returns. Drafts, cancellations, and membership-plan sales are excluded. Food, Space, and Store share each bill by line value.',
    range: {from: range.current.from, to: range.current.to, days: range.days, preset: range.preset},
    previousRange: {from: range.previous.from, to: range.previous.to},
    filters,
    totals: {
      revenue: total,
      bills: current.bills,
      previousRevenue: roundMoney(previous.revenue),
      changePct: changePct(total, previous.revenue),
    },
    segments,
    membership: {
      memberRevenue: current.membership.member,
      otherRevenue: current.membership.other,
      memberBills: current.membership.memberBills,
      otherBills: current.membership.otherBills,
      memberShare: total > 0 ? Math.round((current.membership.member / total) * 1000) / 10 : 0,
      otherShare: total > 0 ? Math.round((current.membership.other / total) * 1000) / 10 : 0,
    },
    top: pictured,
    visitors: visitorSummary(current.customers, prior),
    peak: {
      periods: periodRows,
      busiestPeriod: busiest?.bills ? busiest.label : '',
      highestRevenuePeriod: richest?.revenue ? richest.label : '',
      totalBills: current.bills,
      averageBillsPerDay: range.days > 0 ? Math.round((current.bills / range.days) * 10) / 10 : 0,
      weekdays: weekdayRows,
      busiestDay: busiestDay?.bills ? busiestDay.day : '',
    },
  };
};

const matchesFrequency = (row, bucket, visits) => {
  if (visits === 'all') return true;
  const counts = bucket === 'week' ? row.weekCounts : bucket === 'month' ? row.monthCounts : row.dayCounts;
  const wanted = visits === '3' ? 3 : Number(visits);
  for (const count of counts.values()) {
    if (wanted === 3 ? count >= 3 : count === wanted) return true;
  }
  return false;
};

export const getVisitorPage = async query => {
  const range = resolveInsightsRange(query);
  if (range.error) return {error: range.error};
  const filters = readFilters(query);
  const bucket = ['day', 'week', 'month'].includes(String(query.bucket || query.frequency))
    ? String(query.bucket || query.frequency)
    : 'day';
  const visits = ['all', '1', '2', '3'].includes(String(query.visits)) ? String(query.visits) : 'all';
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(query.limit) || 10));
  const search = String(query.search || '').trim().toLowerCase();

  const invoices = await loadInvoices(range.current);
  const rolled = rollup(invoices, filters, {keepItems: false, keepCustomers: true, keepPeak: false});
  const prior = await priorCustomerKeys(rolled.customers, range.current);
  let rows = [...rolled.customers.values()].map(row => {
    const visitDays = row.days.size;
    const returning = prior.has(row.key) || visitDays > 1;
    return {
      key: row.key,
      customerId: row.customerId,
      name: row.name,
      phone: row.phone,
      visits: visitDays,
      bills: row.bills,
      firstVisit: row.firstVisit,
      lastVisit: row.lastVisit,
      spend: row.spend,
      visitType: returning ? 'Repeat' : 'First Time',
      member: row.member,
    };
  });
  rows = rows.filter(row => matchesFrequency(rolled.customers.get(row.key), bucket, visits));
  if (search) {
    rows = rows.filter(row =>
      row.name.toLowerCase().includes(search) || row.phone.includes(search.replace(/\D/g, '')),
    );
  }
  const sortBy = String(query.sortBy || 'spend');
  rows.sort((a, b) => {
    if (sortBy === 'visits') return b.visits - a.visits || b.spend - a.spend;
    if (sortBy === 'name') return a.name.localeCompare(b.name);
    return b.spend - a.spend || b.visits - a.visits;
  });
  const total = rows.length;
  const start = (page - 1) * limit;
  return {
    success: true,
    bucket,
    visits,
    rows: rows.slice(start, start + limit),
    pagination: {page, limit, total, pages: Math.max(1, Math.ceil(total / limit))},
    summary: visitorSummary(rolled.customers, prior),
  };
};

export const getVisitHistory = async (rawKey, query) => {
  const key = decodeURIComponent(String(rawKey || '')).trim();
  if (!key) return {error: 'Customer is required.'};
  const range = resolveInsightsRange(query);
  if (range.error) return {error: range.error};

  const match = {status: 'final'};
  if (key.startsWith('id:')) match.customerId = key.slice(3);
  else if (key.startsWith('phone:')) {
    const phone = key.slice(6).replace(/\D/g, '');
    if (phone.length !== 10) return {error: 'Customer is required.'};
    match.customerPhone = {$in: [phone, `91${phone}`, `+91${phone}`]};
  } else if (key.startsWith('name:')) {
    match.customerId = null;
    match.customerName = new RegExp(`^${key.slice(5).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  } else return {error: 'Customer is required.'};

  const [summary, invoices] = await Promise.all([
    Invoice.aggregate([
      {$match: match},
      {
        $group: {
          _id: null,
          bills: {$sum: 1},
          spend: {
            $sum: {$max: [0, {$subtract: ['$grandTotal', {$ifNull: ['$returnedAmount', 0]}]}]},
          },
          first: {$min: '$invoiceDate'},
          last: {$max: '$invoiceDate'},
        },
      },
    ]),
    Invoice.find({
      ...match,
      invoiceDate: {$gte: range.current.start, $lte: range.current.end},
    })
      .select('invoiceCode invoiceDate createdAt grandTotal returnedAmount customerName customerPhone membershipType items.productName items.category items.lineTotal items.qty')
      .sort({createdAt: 1})
      .limit(60)
      .lean(),
  ]);

  const billsList = invoices
    .map(invoice => {
      const allocated = allocateInvoice(invoice);
      if (!(allocated.net > 0)) return null;
      return {
        invoiceCode: invoice.invoiceCode,
        date: istParts(invoice.createdAt || invoice.invoiceDate).day,
        amount: allocated.net,
        items: (invoice.items || []).slice(0, 6).map(item => item.productName).filter(Boolean),
      };
    })
    .filter(Boolean);
  const rangeSpend = roundMoney(billsList.reduce((sum, row) => sum + row.amount, 0));
  const visitDays = new Set(billsList.map(row => row.date)).size;
  const sample = invoices[0];
  const life = summary[0] || {};
  return {
    success: true,
    customer: {
      key,
      name: sample?.customerName || 'Customer',
      phone: phoneKey(sample?.customerPhone),
      member: sample ? isMemberInvoice(sample) : false,
    },
    lifetime: {
      bills: life.bills || 0,
      spend: roundMoney(life.spend || 0),
      firstVisit: life.first ? istParts(life.first).day : '',
      lastVisit: life.last ? istParts(life.last).day : '',
    },
    range: {
      from: range.current.from,
      to: range.current.to,
      visits: visitDays,
      bills: billsList.length,
      spend: rangeSpend,
      average: visitDays > 0 ? roundMoney(rangeSpend / visitDays) : 0,
      billsList,
    },
  };
};

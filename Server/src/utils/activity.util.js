const SENSITIVE = /password|passwd|secret|token|cookie|authorization|pin|cvv|card|otp|hash/i;

export const readCompanyId = source => {
  const ref = source?.activeCompany || source?.companyId;
  if (!ref) return '';
  if (typeof ref === 'object') {
    if (ref._id) return String(ref._id);
    const text = typeof ref.toString === 'function' ? ref.toString() : '';
    return text && text !== '[object Object]' ? text : '';
  }
  return String(ref);
};

export const sanitizeValue = value => {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE.test(key) ? '[redacted]' : sanitizeValue(item);
    }
    return out;
  }
  return value;
};

export const diffChanges = (before = {}, after = {}) => {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changes = [];
  for (const field of keys) {
    if (SENSITIVE.test(field) || field === '__v' || field === 'updatedAt') continue;
    const oldValue = before?.[field];
    const newValue = after?.[field];
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
    changes.push({
      field,
      oldValue: sanitizeValue(oldValue ?? null),
      newValue: sanitizeValue(newValue ?? null),
    });
  }
  return changes.slice(0, 40);
};

export const sanitizeChanges = changes => {
  if (!Array.isArray(changes)) return [];
  return changes
    .filter(change => change && !SENSITIVE.test(String(change.field || '')))
    .slice(0, 40)
    .map(change => ({
      field: String(change.field || ''),
      oldValue: sanitizeValue(change.oldValue ?? null),
      newValue: sanitizeValue(change.newValue ?? null),
    }))
    .filter(change => change.field);
};

const MODULE_BY_PREFIX = [
  ['/invoice', 'Invoice'],
  ['/quotation', 'Quotation'],
  ['/customer', 'Customer'],
  ['/product', 'Product'],
  ['/segment', 'Segment'],
  ['/services', 'Services'],
  ['/additional-services', 'Additional Services'],
  ['/api/additional-services', 'Additional Services'],
  ['/api/categories', 'Categories'],
  ['/api/subCategories', 'Subcategories'],
  ['/returnsales', 'Sales Returns'],
  ['/subscriptions', 'Subscriptions'],
  ['/membership', 'Membership'],
  ['/space-bookings', 'Space Bookings'],
  ['/space', 'Space'],
  ['/all-booking', 'All Bookings'],
  ['/booking-overview', 'Booking Overview'],
  ['/food', 'Food'],
  ['/catalogue', 'Catalogue'],
  ['/purchaseOrder', 'Purchase Orders'],
  ['/purchaseReturn', 'Purchase Returns'],
  ['/purchase', 'Purchase'],
  ['/vendor', 'Vendor'],
  ['/inventory', 'Inventory'],
  ['/wallet', 'Wallet'],
  ['/coupon', 'Coupon'],
  ['/space-offers', 'Space Offers'],
  ['/gift-cards', 'Gift Cards'],
  ['/company', 'Company'],
  ['/affiliate', 'Affiliate'],
  ['/access', 'Access'],
  ['/csp', 'CSP'],
  ['/hap', 'HAP'],
  ['/api/customer', 'Customer Authentication'],
  ['/api/announcement', 'Announcements'],
  ['/api/expences/category', 'Expense Categories'],
  ['/api/expences', 'Expenses'],
  ['/dashboard', 'Dashboard'],
  ['/api/commission', 'Staff Commission'],
  ['/api/lead', 'Leads'],
  ['/api/exhibition', 'Exhibition'],
  ['/public/exhibition', 'Public Exhibition'],
  ['/public/invoices', 'Public Invoice'],
  ['/public/gift-cards', 'Public Gift Cards'],
  ['/auth', 'Authentication'],
];

export const moduleFromPath = pathname => {
  const path = String(pathname || '');
  const match = MODULE_BY_PREFIX.find(([prefix]) => path.startsWith(prefix));
  return match ? match[1] : 'System';
};

export const actionFromMethod = method => {
  if (method === 'POST') return 'CREATE';
  if (method === 'PUT' || method === 'PATCH') return 'UPDATE';
  if (method === 'DELETE') return 'DELETE';
  return 'OTHER';
};

export const actionFromRequest = (method, pathname, explicit) => {
  if (explicit) return String(explicit).toUpperCase();
  const path = String(pathname || '').toLowerCase();
  if (path.includes('/login') || path.includes('/verify-otp')) return 'LOGIN';
  if (path.includes('/logout')) return 'LOGOUT';
  if (path.includes('/approve')) return 'APPROVE';
  if (path.includes('/cancel')) return 'CANCEL';
  if (path.includes('/refund')) return 'REFUND';
  if (path.includes('payment')) return 'PAYMENT';
  return actionFromMethod(method);
};

const CRITICAL = new Set([
  'Invoice',
  'Purchase',
  'Purchase Orders',
  'Purchase Returns',
  'Inventory',
  'Wallet',
  'Sales Returns',
  'Gift Cards',
  'Food',
  'Space Bookings',
  'Authentication',
]);

export const isCriticalModule = moduleName => CRITICAL.has(moduleName);

const DOC_KEYS = [
  'invoiceNumber',
  'invoiceCode',
  'quotationNumber',
  'purchaseNumber',
  'poNumber',
  'orderNumber',
  'bookingCode',
  'billNumber',
  'couponCode',
  'productName',
  'foodName',
  'spaceName',
  'name',
  'fullName',
  'title',
];
const PARTY_KEYS = ['customerName', 'vendorName', 'supplierName', 'guestName'];
const AMOUNT_KEYS = ['grandTotal', 'totalAmount', 'paidAmount', 'amountPaid', 'amount'];
const SAFE_META = [
  'customerName',
  'vendorName',
  'supplierName',
  'invoiceNumber',
  'quotationNumber',
  'paymentMode',
  'paymentStatus',
  'status',
  'grandTotal',
  'totalAmount',
  'amount',
  'paidAmount',
];

const asObjects = payload => {
  const list = [];
  const push = value => {
    if (value && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value)) {
      list.push(value);
    }
  };
  push(payload);
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    for (const value of Object.values(payload)) {
      push(value);
      if (Array.isArray(value) && value.length === 1) push(value[0]);
    }
  }
  return list;
};

const firstText = (objects, keys) => {
  for (const obj of objects) {
    for (const key of keys) {
      if (SENSITIVE.test(key)) continue;
      const value = obj[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return '';
};

const firstAmount = objects => {
  for (const obj of objects) {
    for (const key of AMOUNT_KEYS) {
      const value = Number(obj[key]);
      if (Number.isFinite(value) && value !== 0) return value;
    }
  }
  return null;
};

const formatInr = amount =>
  `₹${Number(amount).toLocaleString('en-IN', {maximumFractionDigits: 2})}`;

export const transactionTypeFor = (moduleName, action, pathname) => {
  const path = String(pathname || '').toLowerCase();
  if (action === 'PAYMENT' || path.includes('payment')) return 'payment';
  if (action === 'REFUND' || path.includes('refund')) return 'refund';
  if (moduleName === 'Wallet') return 'wallet';
  if (String(moduleName).includes('Booking')) return 'booking';
  if (moduleName === 'Membership' || moduleName === 'Subscriptions') return 'membership';
  if (moduleName === 'Inventory') return 'inventory';
  return '';
};

export const sourceFromRequest = req => {
  const explicit = String(req?.headers?.['x-client-source'] || '').trim();
  if (explicit) return explicit.slice(0, 40);
  const path = String(req?.originalUrl || '').toLowerCase();
  if (path.startsWith('/api/customer') || path.startsWith('/public/')) return 'Customer Portal';
  if (path.includes('/pos') || String(req?.body?.mode || '').toUpperCase() === 'POS') return 'POS';
  if (!req?.user && !req?.staff && !req?.customer) return 'System';
  if (/mobile|android|iphone|ipad/i.test(String(req?.headers?.['user-agent'] || ''))) return 'Mobile';
  return 'Web';
};

const VERB = {
  CREATE: 'Created',
  UPDATE: 'Updated',
  DELETE: 'Deleted',
  PAYMENT: 'Recorded a payment on',
  CANCEL: 'Cancelled',
  APPROVE: 'Approved',
  REFUND: 'Refunded',
  LOGIN: 'Signed in',
  LOGOUT: 'Signed out',
};

export const describeActivity = ({payload, body, action, moduleName, failed, pathname}) => {
  const objects = asObjects(payload).concat(asObjects(body));
  const resourceName = firstText(objects, DOC_KEYS);
  const relatedName = firstText(objects, PARTY_KEYS);
  const amount = firstAmount(objects);
  const resourceId = firstText(objects, ['_id', 'id']);
  const verb = VERB[action] || action || 'Updated';
  const moduleLabel = String(moduleName || 'record').toLowerCase();
  let description = resourceName ? `${verb} ${moduleLabel} ${resourceName}` : `${verb} ${moduleLabel}`;
  if (relatedName && relatedName !== resourceName) description += ` for ${relatedName}`;
  if (amount != null) description += ` — ${formatInr(amount)}`;
  if (failed) description = `Failed: ${description}`;
  const metadata = {};
  for (const obj of objects) {
    for (const key of SAFE_META) {
      if (metadata[key] != null || SENSITIVE.test(key)) continue;
      const value = obj[key];
      if (value == null || value === '' || typeof value === 'object') continue;
      metadata[key] = value;
    }
  }
  if (amount != null) metadata.totalAmount = amount;
  return {
    description,
    resourceName,
    resourceId,
    relatedName,
    amount,
    transactionType: transactionTypeFor(moduleName, action, pathname),
    metadata,
  };
};
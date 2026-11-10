const SENSITIVE = /password|passwd|secret|token|cookie|authorization|pin|cvv|card|otp|hash/i;

export const readCompanyId = source => {
  const ref = source?.activeCompany || source?.companyId;
  if (!ref) return '';
  if (typeof ref === 'object') return String(ref._id || '');
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
  'Authentication',
]);

export const isCriticalModule = moduleName => CRITICAL.has(moduleName);
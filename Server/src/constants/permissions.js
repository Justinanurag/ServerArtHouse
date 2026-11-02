/**
 * WooWooErp Admin — Permission Catalog (source of truth for Server)
 *
 * Format: resource.action
 * Example: invoice.create
 *
 * Keep in sync with: Client/src/constants/permissions.ts
 */

export const PERMISSIONS = Object.freeze({
  // System
  DASHBOARD_READ: 'dashboard.read',
  ACCESS_READ: 'access.read',
  ACCESS_MANAGE: 'access.manage',
  COMPANY_READ: 'company.read',
  COMPANY_MANAGE: 'company.manage',

  // Sales — Invoice / POS
  INVOICE_READ: 'invoice.read',
  INVOICE_CREATE: 'invoice.create',
  INVOICE_UPDATE: 'invoice.update',
  INVOICE_DELETE: 'invoice.delete',

  // Sales — Quotation
  QUOTATION_READ: 'quotation.read',
  QUOTATION_CREATE: 'quotation.create',
  QUOTATION_UPDATE: 'quotation.update',
  QUOTATION_DELETE: 'quotation.delete',

  // Sales — Credit notes / sales return
  CREDIT_NOTE_READ: 'credit_note.read',
  CREDIT_NOTE_CREATE: 'credit_note.create',

  // Sales — Subscriptions
  SUBSCRIPTION_READ: 'subscription.read',
  SUBSCRIPTION_CREATE: 'subscription.create',
  SUBSCRIPTION_UPDATE: 'subscription.update',
  SUBSCRIPTION_DELETE: 'subscription.delete',
  SUBSCRIPTION_BULK_CREATE: 'subscription.bulk.create',

  // Purchases
  PURCHASE_READ: 'purchase.read',
  PURCHASE_CREATE: 'purchase.create',
  PURCHASE_UPDATE: 'purchase.update',
  PURCHASE_DELETE: 'purchase.delete',
  PURCHASE_ORDER_READ: 'purchase_order.read',
  PURCHASE_ORDER_CREATE: 'purchase_order.create',
  PURCHASE_ORDER_UPDATE: 'purchase_order.update',
  PURCHASE_ORDER_DELETE: 'purchase_order.delete',
  DEBIT_NOTE_READ: 'debit_note.read',
  DEBIT_NOTE_CREATE: 'debit_note.create',

  // Expenses
  EXPENSE_READ: 'expense.read',
  EXPENSE_CREATE: 'expense.create',
  EXPENSE_UPDATE: 'expense.update',
  EXPENSE_DELETE: 'expense.delete',

  // Inventory
  INVENTORY_READ: 'inventory.read',
  INVENTORY_MANAGE: 'inventory.manage',
  INVENTORY_TIMELINE_READ: 'inventory.timeline.read',

  // Catalogue — Products
  PRODUCT_READ: 'product.read',
  PRODUCT_CREATE: 'product.create',
  PRODUCT_UPDATE: 'product.update',
  PRODUCT_DELETE: 'product.delete',
  PRODUCT_BULK_CREATE: 'product.bulk.create',

  // Catalogue — Services
  SERVICE_READ: 'service.read',
  SERVICE_CREATE: 'service.create',
  SERVICE_UPDATE: 'service.update',
  SERVICE_DELETE: 'service.delete',

  // Catalogue — Spaces
  SPACE_READ: 'space.read',
  SPACE_CREATE: 'space.create',
  SPACE_UPDATE: 'space.update',
  SPACE_DELETE: 'space.delete',

  // Space bookings
  SPACE_BOOKING_READ: 'space_booking.read',
  SPACE_BOOKING_CREATE: 'space_booking.create',
  SPACE_BOOKING_UPDATE: 'space_booking.update',
  SPACE_BOOKING_DELETE: 'space_booking.delete',

  // Catalogue — Foods
  FOOD_READ: 'food.read',
  FOOD_CREATE: 'food.create',
  FOOD_UPDATE: 'food.update',
  FOOD_DELETE: 'food.delete',

  // Catalogue — Membership plans / categories
  MEMBERSHIP_PLAN_READ: 'membership_plan.read',
  MEMBERSHIP_PLAN_MANAGE: 'membership_plan.manage',
  CATEGORY_MANAGE: 'category.manage',

  // Network
  CUSTOMER_READ: 'customer.read',
  CUSTOMER_CREATE: 'customer.create',
  CUSTOMER_UPDATE: 'customer.update',
  CUSTOMER_DELETE: 'customer.delete',
  VENDOR_READ: 'vendor.read',
  VENDOR_CREATE: 'vendor.create',
  VENDOR_UPDATE: 'vendor.update',
  VENDOR_DELETE: 'vendor.delete',
  PARTNER_READ: 'partner.read',
  GUEST_READ: 'guest.read',
  CSP_READ: 'csp.read',
  CSP_WRITE: 'csp.write',

  // Wallet / Coupons / Affiliate
  WALLET_READ: 'wallet.read',
  WALLET_MANAGE: 'wallet.manage',
  COUPON_READ: 'coupon.read',
  COUPON_MANAGE: 'coupon.manage',

  // Gift cards
  GIFT_CARD_READ: 'gift_card.read',
  GIFT_CARD_CREATE: 'gift_card.create',
  GIFT_CARD_UPDATE: 'gift_card.update',
  GIFT_CARD_DELETE: 'gift_card.delete',

  // Exhibition entry passes
  EXHIBITION_READ: 'exhibition.read',
  EXHIBITION_CREATE: 'exhibition.create',
  EXHIBITION_UPDATE: 'exhibition.update',
  EXHIBITION_DELETE: 'exhibition.delete',

  // Announcements (WhatsApp blasts)
  ANNOUNCEMENT_READ: 'announcement.read',
  ANNOUNCEMENT_CREATE: 'announcement.create',
  AFFILIATE_READ: 'affiliate.read',
  AFFILIATE_MANAGE: 'affiliate.manage',
  AFFILIATE_PAYOUT: 'affiliate.payout',

  // Staff commission
  STAFF_COMMISSION_READ: 'staff.commission.read',

  // INVOICEDBY_READ: 'invoicedby.read',
  // INVOICEDBY_WRITE: 'invoicedby.write',
});

/** Flat list of every permission key (for seeding / validation). */
export const ALL_PERMISSIONS = Object.freeze(Object.values(PERMISSIONS));

/**
 * Grouped metadata for Access UI / docs.
 * key = permission string, module = sidebar area, label = human text
 */
export const PERMISSION_CATALOG = Object.freeze([
  // System
  {key: PERMISSIONS.DASHBOARD_READ, module: 'system', label: 'View dashboard'},
  {key: PERMISSIONS.ACCESS_READ, module: 'system', label: 'View access control'},
  {key: PERMISSIONS.ACCESS_MANAGE, module: 'system', label: 'Manage roles & permissions'},
  {key: PERMISSIONS.COMPANY_READ, module: 'system', label: 'View companies'},
  {key: PERMISSIONS.COMPANY_MANAGE, module: 'system', label: 'Manage companies'},

  // Sales
  {key: PERMISSIONS.INVOICE_READ, module: 'sales', label: 'View invoices'},
  {key: PERMISSIONS.INVOICE_CREATE, module: 'sales', label: 'Create invoices'},
  {key: PERMISSIONS.INVOICE_UPDATE, module: 'sales', label: 'Update invoices'},
  {key: PERMISSIONS.INVOICE_DELETE, module: 'sales', label: 'Delete/cancel invoices'},
  {key: PERMISSIONS.QUOTATION_READ, module: 'sales', label: 'View quotations'},
  {key: PERMISSIONS.QUOTATION_CREATE, module: 'sales', label: 'Create quotations'},
  {key: PERMISSIONS.QUOTATION_UPDATE, module: 'sales', label: 'Update quotations'},
  {key: PERMISSIONS.QUOTATION_DELETE, module: 'sales', label: 'Delete quotations'},
  {key: PERMISSIONS.CREDIT_NOTE_READ, module: 'sales', label: 'View credit notes'},
  {key: PERMISSIONS.CREDIT_NOTE_CREATE, module: 'sales', label: 'Create credit notes'},
  {key: PERMISSIONS.SUBSCRIPTION_READ, module: 'sales', label: 'View subscriptions'},
  {key: PERMISSIONS.SUBSCRIPTION_CREATE, module: 'sales', label: 'Create subscriptions'},
  {key: PERMISSIONS.SUBSCRIPTION_BULK_CREATE, module: 'sales', label: 'Create bulk subscriptions'},
  {key: PERMISSIONS.SUBSCRIPTION_UPDATE, module: 'sales', label: 'Update subscriptions'},
  {key: PERMISSIONS.SUBSCRIPTION_DELETE, module: 'sales', label: 'Delete subscriptions'},

  // Purchases
  {key: PERMISSIONS.PURCHASE_READ, module: 'purchases', label: 'View purchases'},
  {key: PERMISSIONS.PURCHASE_CREATE, module: 'purchases', label: 'Create purchases'},
  {key: PERMISSIONS.PURCHASE_UPDATE, module: 'purchases', label: 'Update purchases'},
  {key: PERMISSIONS.PURCHASE_DELETE, module: 'purchases', label: 'Delete purchases'},
  {key: PERMISSIONS.PURCHASE_ORDER_READ, module: 'purchases', label: 'View purchase orders'},
  {key: PERMISSIONS.PURCHASE_ORDER_CREATE, module: 'purchases', label: 'Create purchase orders'},
  {key: PERMISSIONS.PURCHASE_ORDER_UPDATE, module: 'purchases', label: 'Update purchase orders'},
  {key: PERMISSIONS.PURCHASE_ORDER_DELETE, module: 'purchases', label: 'Delete purchase orders'},
  {key: PERMISSIONS.DEBIT_NOTE_READ, module: 'purchases', label: 'View debit notes'},
  {key: PERMISSIONS.DEBIT_NOTE_CREATE, module: 'purchases', label: 'Create debit notes'},

  // Expenses
  {key: PERMISSIONS.EXPENSE_READ, module: 'expenses', label: 'View expenses'},
  {key: PERMISSIONS.EXPENSE_CREATE, module: 'expenses', label: 'Create expenses'},
  {key: PERMISSIONS.EXPENSE_UPDATE, module: 'expenses', label: 'Update expenses / record payments'},
  {key: PERMISSIONS.EXPENSE_DELETE, module: 'expenses', label: 'Delete expenses'},

  // Inventory
  {key: PERMISSIONS.INVENTORY_READ, module: 'inventory', label: 'View inventory'},
  {key: PERMISSIONS.INVENTORY_MANAGE, module: 'inventory', label: 'Manage inventory'},
  {key: PERMISSIONS.INVENTORY_TIMELINE_READ, module: 'inventory', label: 'View inventory timeline'},

  // Catalogue
  {key: PERMISSIONS.PRODUCT_READ, module: 'catalogue', label: 'View products'},
  {key: PERMISSIONS.PRODUCT_CREATE, module: 'catalogue', label: 'Create products'},
  {key: PERMISSIONS.PRODUCT_BULK_CREATE, module: 'catalogue', label: 'Create bulk products'},
  {key: PERMISSIONS.PRODUCT_UPDATE, module: 'catalogue', label: 'Update products'},
  {key: PERMISSIONS.PRODUCT_DELETE, module: 'catalogue', label: 'Delete products'},
  {key: PERMISSIONS.SERVICE_READ, module: 'catalogue', label: 'View services'},
  {key: PERMISSIONS.SERVICE_CREATE, module: 'catalogue', label: 'Create services'},
  {key: PERMISSIONS.SERVICE_UPDATE, module: 'catalogue', label: 'Update services'},
  {key: PERMISSIONS.SERVICE_DELETE, module: 'catalogue', label: 'Delete services'},
  {key: PERMISSIONS.SPACE_READ, module: 'catalogue', label: 'View spaces'},
  {key: PERMISSIONS.SPACE_CREATE, module: 'catalogue', label: 'Create spaces'},
  {key: PERMISSIONS.SPACE_UPDATE, module: 'catalogue', label: 'Update spaces'},
  {key: PERMISSIONS.SPACE_DELETE, module: 'catalogue', label: 'Delete spaces'},
  {key: PERMISSIONS.SPACE_BOOKING_READ, module: 'space_booking', label: 'View space bookings'},
  {key: PERMISSIONS.SPACE_BOOKING_CREATE, module: 'space_booking', label: 'Create space bookings'},
  {key: PERMISSIONS.SPACE_BOOKING_UPDATE, module: 'space_booking', label: 'Update space bookings'},
  {key: PERMISSIONS.SPACE_BOOKING_DELETE, module: 'space_booking', label: 'Delete space bookings'},
  {key: PERMISSIONS.FOOD_READ, module: 'catalogue', label: 'View foods'},
  {key: PERMISSIONS.FOOD_CREATE, module: 'catalogue', label: 'Create foods'},
  {key: PERMISSIONS.FOOD_UPDATE, module: 'catalogue', label: 'Update foods'},
  {key: PERMISSIONS.FOOD_DELETE, module: 'catalogue', label: 'Delete foods'},
  {key: PERMISSIONS.MEMBERSHIP_PLAN_READ, module: 'catalogue', label: 'View membership plans'},
  {key: PERMISSIONS.MEMBERSHIP_PLAN_MANAGE, module: 'catalogue', label: 'Manage membership plans'},
  {key: PERMISSIONS.CATEGORY_MANAGE, module: 'catalogue', label: 'Manage categories'},

  // Network
  {key: PERMISSIONS.CUSTOMER_READ, module: 'network', label: 'View customers'},
  {key: PERMISSIONS.CUSTOMER_CREATE, module: 'network', label: 'Create customers'},
  {key: PERMISSIONS.CUSTOMER_UPDATE, module: 'network', label: 'Update customers'},
  {key: PERMISSIONS.CUSTOMER_DELETE, module: 'network', label: 'Delete customers'},
  {key: PERMISSIONS.VENDOR_READ, module: 'network', label: 'View vendors'},
  {key: PERMISSIONS.VENDOR_CREATE, module: 'network', label: 'Create vendors'},
  {key: PERMISSIONS.VENDOR_UPDATE, module: 'network', label: 'Update vendors'},
  {key: PERMISSIONS.VENDOR_DELETE, module: 'network', label: 'Delete vendors'},
  {key: PERMISSIONS.PARTNER_READ, module: 'network', label: 'View partners'},
  {key: PERMISSIONS.GUEST_READ, module: 'network', label: 'View guests'},
  {key: PERMISSIONS.CSP_READ, module: 'network', label: 'View CSP sailors'},
  {key: PERMISSIONS.CSP_WRITE, module: 'network', label: 'Enroll / manage CSP sailors'},

  // Money / marketing
  {key: PERMISSIONS.WALLET_READ, module: 'wallet', label: 'View wallets'},
  {key: PERMISSIONS.WALLET_MANAGE, module: 'wallet', label: 'Manage wallets'},
  {key: PERMISSIONS.COUPON_READ, module: 'coupons', label: 'View coupons'},
  {key: PERMISSIONS.COUPON_MANAGE, module: 'coupons', label: 'Manage coupons'},
  {key: PERMISSIONS.GIFT_CARD_READ, module: 'gift_cards', label: 'View gift cards'},
  {key: PERMISSIONS.GIFT_CARD_CREATE, module: 'gift_cards', label: 'Create gift cards'},
  {key: PERMISSIONS.GIFT_CARD_UPDATE, module: 'gift_cards', label: 'Update gift cards'},
  {key: PERMISSIONS.GIFT_CARD_DELETE, module: 'gift_cards', label: 'Delete gift cards'},
  {key: PERMISSIONS.EXHIBITION_READ, module: 'exhibition', label: 'View exhibition passes'},
  {key: PERMISSIONS.EXHIBITION_CREATE, module: 'exhibition', label: 'Create exhibition passes'},
  {key: PERMISSIONS.EXHIBITION_UPDATE, module: 'exhibition', label: 'Update exhibition passes'},
  {key: PERMISSIONS.EXHIBITION_DELETE, module: 'exhibition', label: 'Delete exhibition passes'},
  {key: PERMISSIONS.ANNOUNCEMENT_READ, module: 'announcements', label: 'View announcements'},
  {key: PERMISSIONS.ANNOUNCEMENT_CREATE, module: 'announcements', label: 'Send announcements'},
  {key: PERMISSIONS.AFFILIATE_READ, module: 'affiliate', label: 'View affiliate program'},
  {key: PERMISSIONS.AFFILIATE_MANAGE, module: 'affiliate', label: 'Manage affiliate settings'},
  {key: PERMISSIONS.AFFILIATE_PAYOUT, module: 'affiliate', label: 'Process affiliate payouts'},

  {key: PERMISSIONS.STAFF_COMMISSION_READ, module: 'staff', label: 'View staff commission'},
]);

/** Minimum permission required to SHOW a sidebar item / route.
 * Used later by LeftSideBar + route guards.
 * Value may be a single permission or an array (ANY of them is enough).
 */
export const MENU_PERMISSION_MAP = Object.freeze({
  '/': PERMISSIONS.DASHBOARD_READ,
  '/pos': PERMISSIONS.INVOICE_READ,
  '/invoices': PERMISSIONS.INVOICE_READ,
  '/payments': PERMISSIONS.INVOICE_READ,
  '/create-invoice': PERMISSIONS.INVOICE_CREATE,
  '/create-pos': PERMISSIONS.INVOICE_CREATE,
  '/quotations': PERMISSIONS.QUOTATION_READ,
  '/create-quotation': PERMISSIONS.QUOTATION_CREATE,
  '/creditnotes': PERMISSIONS.CREDIT_NOTE_READ,
  '/create-sales-return': PERMISSIONS.CREDIT_NOTE_CREATE,
  '/subscriptions': PERMISSIONS.SUBSCRIPTION_READ,
  '/create-subscription': PERMISSIONS.SUBSCRIPTION_CREATE,
  '/purchase': PERMISSIONS.PURCHASE_READ,
  '/create-purchase': PERMISSIONS.PURCHASE_CREATE,
  '/purchase-orders': PERMISSIONS.PURCHASE_ORDER_READ,
  '/create-purchase-order': PERMISSIONS.PURCHASE_ORDER_CREATE,
  '/debit-notes': PERMISSIONS.DEBIT_NOTE_READ,
  '/create-purchase-return': PERMISSIONS.DEBIT_NOTE_CREATE,
  '/expenses': PERMISSIONS.EXPENSE_READ,
  '/inventory': PERMISSIONS.INVENTORY_READ,
  '/inventory-timeline': PERMISSIONS.INVENTORY_TIMELINE_READ,
  '/products': PERMISSIONS.PRODUCT_READ,
  '/create-new-product': PERMISSIONS.PRODUCT_CREATE,
  '/services': PERMISSIONS.SERVICE_READ,
  '/spaces': PERMISSIONS.SPACE_READ,
  '/spaceBooking': PERMISSIONS.SPACE_BOOKING_READ,
  '/allBookings': [PERMISSIONS.SPACE_BOOKING_READ, PERMISSIONS.INVOICE_READ],
  '/bookingOverView': [PERMISSIONS.SPACE_BOOKING_READ, PERMISSIONS.INVOICE_READ],
  '/foods': PERMISSIONS.FOOD_READ,
  '/manage-plans': PERMISSIONS.MEMBERSHIP_PLAN_READ,
  '/membership': PERMISSIONS.MEMBERSHIP_PLAN_READ,
  '/create-new-membership': PERMISSIONS.MEMBERSHIP_PLAN_MANAGE,
  '/members-and-partners': PERMISSIONS.MEMBERSHIP_PLAN_READ,
  '/customers': PERMISSIONS.CUSTOMER_READ,
  // CSP: dedicated perm OR customer network access (so menu shows for existing staff)
  '/csp': [PERMISSIONS.CSP_READ, PERMISSIONS.CUSTOMER_READ],
  '/hap': [PERMISSIONS.AFFILIATE_READ, PERMISSIONS.CUSTOMER_READ, PERMISSIONS.CSP_READ],
  '/vendors': PERMISSIONS.VENDOR_READ,
  '/Vendor list': PERMISSIONS.VENDOR_READ,
  '/partners': PERMISSIONS.PARTNER_READ,
  '/guests': PERMISSIONS.GUEST_READ,
  '/wallet': PERMISSIONS.WALLET_READ,
  '/coupons': PERMISSIONS.COUPON_READ,
  '/announcements': PERMISSIONS.ANNOUNCEMENT_READ,
  '/affiliate-program': PERMISSIONS.AFFILIATE_READ,
  '/staffCommission': PERMISSIONS.STAFF_COMMISSION_READ,
  '/exhibitiontable': PERMISSIONS.EXHIBITION_READ,
  '/access': PERMISSIONS.ACCESS_READ,
});

export const isValidPermission = permission =>
  ALL_PERMISSIONS.includes(String(permission || '').trim());

export const hasPermission = (userPermissions = [], required) => {
  if (!required) return true;
  const list = Array.isArray(userPermissions) ? userPermissions : [];
  return list.includes(required);
};

export const hasAnyPermission = (userPermissions = [], requiredList = []) => {
  if (!Array.isArray(requiredList) || requiredList.length === 0) return true;
  return requiredList.some(p => hasPermission(userPermissions, p));
};

export const hasAllPermissions = (userPermissions = [], requiredList = []) => {
  if (!Array.isArray(requiredList) || requiredList.length === 0) return true;
  return requiredList.every(p => hasPermission(userPermissions, p));
};

/** Resolve MENU_PERMISSION_MAP entry to a permission list (ANY). */
export const resolveMenuPermissions = required => {
  if (!required) return [];
  return (Array.isArray(required) ? required : [required]).filter(Boolean);
};

export const normalizePermissionList = (value = []) => {
  const raw = Array.isArray(value) ? value : [];
  return [...new Set(raw.map(v => String(v || '').trim()).filter(isValidPermission))];
};

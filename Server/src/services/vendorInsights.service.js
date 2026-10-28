import Purchase from '../models/purchase.model.js';
import CustomersailorProgram from '../models/customerSellerProgram.model.js';

const CLOSED = new Set(['cancelled', 'draft']);

const roundMoney = value => Math.round((Number(value) || 0) * 100) / 100;

const digits = value => String(value || '').replace(/\D/g, '');

const isOpenPurchase = doc => !CLOSED.has(String(doc?.status || '').trim().toLowerCase());

const matchVendorId = (purchase, byPhone, byName) => {
  const phone = digits(purchase.supplierContact).slice(-10);
  if (phone.length >= 10 && byPhone.get(phone)?.length === 1) {
    return byPhone.get(phone)[0];
  }
  const name = String(purchase.supplierName || '').trim().toLowerCase();
  if (name && byName.get(name)?.length === 1) return byName.get(name)[0];
  return '';
};

/** Confirmed purchase totals for the vendor table. Cancelled and draft bills are excluded. */
export async function vendorListStats(vendors) {
  const list = vendors.map(vendor => (vendor.toObject ? vendor.toObject() : vendor));
  const ids = list.map(vendor => vendor._id).filter(Boolean);
  const [enrollments, purchases] = await Promise.all([
    ids.length
      ? CustomersailorProgram.find({vendorId: {$in: ids}, status: 'active'})
          .select('vendorId displayName')
          .lean()
      : [],
    Purchase.find({status: {$nin: ['cancelled', 'draft', 'Cancelled', 'Draft']}})
      .select('supplierName supplierContact amount paidAmount dueAmount invoiceDate createdAt status')
      .lean(),
  ]);

  const labelByVendor = new Map();
  for (const row of enrollments) {
    const name = String(row.displayName || '').trim();
    labelByVendor.set(String(row.vendorId), name ? `CSP · ${name}` : 'CSP');
  }

  const byPhone = new Map();
  const byName = new Map();
  const add = (map, key, id) => {
    if (!key) return;
    const bucket = map.get(key) || [];
    bucket.push(id);
    map.set(key, bucket);
  };
  for (const vendor of list) {
    const id = String(vendor._id);
    add(byPhone, digits(vendor.mobile).slice(-10), id);
    add(byPhone, digits(vendor.businessPhoneNumber).slice(-10), id);
    add(byName, String(vendor.name || '').trim().toLowerCase(), id);
    add(byName, String(vendor.companyName || '').trim().toLowerCase(), id);
  }

  const stats = new Map();
  for (const purchase of purchases.filter(isOpenPurchase)) {
    const id = matchVendorId(purchase, byPhone, byName);
    if (!id) continue;
    const current = stats.get(id) || {
      totalPurchase: 0,
      purchaseFrequency: 0,
      totalPaid: 0,
      outstandingAmount: 0,
      lastPurchaseDate: null,
    };
    current.totalPurchase += Number(purchase.amount) || 0;
    current.purchaseFrequency += 1;
    current.totalPaid += Number(purchase.paidAmount) || 0;
    current.outstandingAmount += Number(purchase.dueAmount) || 0;
    const when = purchase.invoiceDate || purchase.createdAt;
    if (when && (!current.lastPurchaseDate || new Date(when) > new Date(current.lastPurchaseDate))) {
      current.lastPurchaseDate = when;
    }
    stats.set(id, current);
  }

  return list.map(vendor => {
    const row = stats.get(String(vendor._id)) || {
      totalPurchase: 0,
      purchaseFrequency: 0,
      totalPaid: 0,
      outstandingAmount: 0,
      lastPurchaseDate: null,
    };
    return {
      ...vendor,
      cspLabel: labelByVendor.get(String(vendor._id)) || '',
      totalPurchase: roundMoney(row.totalPurchase),
      purchaseFrequency: row.purchaseFrequency,
      totalPaid: roundMoney(row.totalPaid),
      outstandingAmount: roundMoney(row.outstandingAmount),
      lastPurchaseDate: row.lastPurchaseDate,
      status: vendor.isActive === false ? 'Inactive' : 'Active',
    };
  });
}

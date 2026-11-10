import mongoose from 'mongoose';
import Customer from '../models/customer.model.js';
import Vendor from '../models/vendor.model.js';
import CustomersailorProgram from '../models/customerSellerProgram.model.js';
import CspApplication from '../models/cspApplication.model.js';
import CspSettlement from '../models/cspSettlement.model.js';
import Product from '../models/product.model.js';
import Wallet from '../models/wallet.model.js';
import WalletWithdrawal from '../models/walletWithdrawal.model.js';
import {resolveTwoBuckets} from '../utils/walletBuckets.js';
import {attachMembershipExpiry} from '../services/membershipEligibility.service.js';
import Membership from '../models/membership.model.js';
import Purchase from '../models/purchase.model.js';
import PurchaseOrder from '../models/purchaseOrder.model.js';
import Invoice from '../models/invoice.model.js';

const escapeRegex = value => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getsailorSharePercent = () => {
  const n = Number(process.env.CSP_sailor_SHARE_PERCENT ?? 70);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 70;
};

const getPlatformSharePercent = () => {
  const n = Number(process.env.CSP_PLATFORM_SHARE_PERCENT ?? 30);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 30;
};

const normalizeMobile = raw => {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    const ten = digits.slice(2);
    return /^[6-9]\d{9}$/.test(ten) ? ten : null;
  }
  if (digits.length === 10 && /^[6-9]\d{9}$/.test(digits)) return digits;
  // Vendors sometimes store non-strict mobiles; keep last 10 digits if present
  if (digits.length >= 10) return digits.slice(-10);
  return digits || null;
};

const PROSITE_PATTERN =
  /^(?:https?:\/\/)?(?:www\.)?1atives\.com\/pro\/[a-z0-9][a-z0-9_-]*\/?$/i;

const normalizePrositeUrl = raw => {
  const value = String(raw || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '');
  if (!value) return '';
  if (!PROSITE_PATTERN.test(value) && !PROSITE_PATTERN.test(`https://${value}`)) {
    return null;
  }
  return value.toLowerCase();
};

const formatCspLabel = name => {
  const n = String(name || '').trim() || 'Sailor';
  return `CSP · ${n}`;
};

/** CSP enrollment requires Premium membership only. */
const isPremiumMembership = membershipType => {
  const v = String(membershipType ?? '')
    .trim()
    .toLowerCase();
  return v === 'premium';
};

const assertPremiumForCsp = customer => {
  if (!isPremiumMembership(customer?.membershipType)) {
    const error = new Error(
      'Only customers with Premium membership can become CSP sailors. Activate Premium membership first.',
    );
    error.status = 400;
    throw error;
  }
};

const toEnrollmentDto = doc => {
  const plain = doc?.toObject ? doc.toObject() : doc;
  const customer =
    plain?.customerId && typeof plain.customerId === 'object'
      ? plain.customerId
      : null;
  const vendor =
    plain?.vendorId && typeof plain.vendorId === 'object' ? plain.vendorId : null;
  const displayName =
    String(plain?.displayName || '').trim() ||
    String(customer?.name || vendor?.name || '').trim() ||
    'Sailor';
  const mobile =
    String(plain?.mobile || '').trim() ||
    String(customer?.mobile || vendor?.mobile || '').trim();

  return {
    ...plain,
    customerId: customer?._id || plain?.customerId || null,
    vendorId: vendor?._id || plain?.vendorId || null,
    customer,
    vendor,
    displayName,
    mobile,
    label: formatCspLabel(displayName),
  };
};

const populateEnrollment = query =>
  query
    .populate(
      'customerId',
      'name mobile email walletAmount membershipType membershipPlanId membershipPurchase withdrawable affiliateBalance nonWithdrawable cashbackBalance closingBalance',
    )
    .populate(
      'vendorId',
      'name mobile email companyName website businessEmail',
    );

/**
 * GET /csp
 * List CSP enrollments (default: active only).
 */
export const getCSP = async (req, res) => {
  try {
    const status = String(req.query.status ?? 'active').trim().toLowerCase();
    const search = String(req.query.search ?? '').trim();
    const query = {};

    if (status === 'active' || status === 'inactive') {
      query.status = status;
    } else if (status !== 'all') {
      query.status = 'active';
    }

    if (search) {
      const regex = new RegExp(
        search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        'i',
      );
      query.$or = [{displayName: regex}, {mobile: regex}];
    }

    const rows = await populateEnrollment(
      CustomersailorProgram.find(query).sort({createdAt: -1}),
    );

    const customerIds = rows
      .map(row => {
        const plain = row?.toObject ? row.toObject() : row;
        const customer =
          plain?.customerId && typeof plain.customerId === 'object'
            ? plain.customerId
            : null;
        return customer?._id || plain?.customerId || null;
      })
      .filter(id => id && mongoose.Types.ObjectId.isValid(String(id)));

    const wallets = customerIds.length
      ? await Wallet.find({customerId: {$in: customerIds}})
          .select(
            'customerId withdrawable nonWithdrawable affiliateBalance cashbackBalance walletAmount balanceSchema',
          )
          .lean()
      : [];

    const walletMap = new Map(
      wallets.map(w => [String(w.customerId), w]),
    );

    const enrollmentIds = rows.map(row => row._id).filter(Boolean);
    const [settlements, withdrawals] = await Promise.all([
      enrollmentIds.length
        ? CspSettlement.find({
            status: {$ne: 'reversed'},
            'lines.cspEnrollmentId': {$in: enrollmentIds},
          })
            .select('lines')
            .lean()
        : [],
      customerIds.length
        ? WalletWithdrawal.find({customer: {$in: customerIds}})
            .select('customer amount status')
            .lean()
        : [],
    ]);

    const salesByEnrollment = new Map();
    for (const settlement of settlements) {
      for (const line of settlement.lines || []) {
        const id = String(line.cspEnrollmentId || '');
        if (!id) continue;
        const current = salesByEnrollment.get(id) || {salesAmount: 0};
        current.salesAmount += Number(line.lineBaseAmount) || 0;
        salesByEnrollment.set(id, current);
      }
    }

    const payoutByCustomer = new Map();
    const paidStatuses = new Set(['paid']);
    for (const withdrawal of withdrawals) {
      if (!paidStatuses.has(withdrawal.status)) continue;
      const id = String(withdrawal.customer || '');
      payoutByCustomer.set(
        id,
        (payoutByCustomer.get(id) || 0) + (Number(withdrawal.amount) || 0),
      );
    }

    const enrollments = rows.map(row => {
      const dto = toEnrollmentDto(row);
      const customerId = dto.customerId ? String(dto.customerId) : '';
    const wallet = customerId ? walletMap.get(customerId) : null;
      const buckets = resolveTwoBuckets(wallet, dto.customer);
      const sales = salesByEnrollment.get(String(row._id)) || {salesAmount: 0};
      const payoutAmount = customerId ? payoutByCustomer.get(customerId) || 0 : 0;
      return {
        ...dto,
        withdrawable: buckets.withdrawable,
        withdrawableBalance: buckets.withdrawable,
        affiliateBalance: buckets.withdrawable,
        nonWithdrawable: buckets.nonWithdrawable,
        walletAmount: buckets.total,
        salesAmount: Math.round(sales.salesAmount * 100) / 100,
        payoutAmount: Math.round(payoutAmount * 100) / 100,
      };
    });

    await attachMembershipExpiry(
      enrollments.map(row => row.customer).filter(Boolean),
    );

    return res.status(200).json({
      success: true,
      message: 'CSP list fetched successfully.',
      enrollments,
      // backward-compatible alias
      csps: enrollments,
    });
  } catch (error) {
    console.error('getCSP error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch CSP enrollments.',
    });
  }
};

/**
 * POST /csp/enroll
 * Enroll an existing customer (or create one) and auto create/link Vendor.
 */
export const enrollCsp = async (req, res) => {
  try {
    const {
      customerId,
      vendorId,
      name,
      mobile,
      email,
      companyName,
      address,
      city,
      state,
      pincode,
      sailorSharePercent,
      platformSharePercent,
      prositeUrl: prositeUrlRaw,
    } = req.body || {};

    const prositeUrl = normalizePrositeUrl(prositeUrlRaw);
    if (String(prositeUrlRaw || '').trim() && !prositeUrl) {
      return res.status(400).json({
        success: false,
        message: 'Prosite URL must look like 1atives.com/pro/yourname.',
      });
    }
    if (!prositeUrl) {
      return res.status(400).json({
        success: false,
        message: 'Prosite URL is required.',
      });
    }

    let customer = null;
    if (customerId && mongoose.Types.ObjectId.isValid(customerId)) {
      customer = await Customer.findOne({
        _id: customerId,
        isDeleted: {$ne: true},
      });
      if (!customer) {
        return res.status(404).json({
          success: false,
          message: 'Customer not found.',
        });
      }
    } else {
      const mobileNorm = normalizeMobile(mobile);
      const nameNorm = String(name ?? '').trim();
      if (!nameNorm || !mobileNorm) {
        return res.status(400).json({
          success: false,
          message: 'customerId or (name + mobile) is required to enroll CSP.',
        });
      }

      customer = await Customer.findOne({
        mobile: mobileNorm,
        isDeleted: {$ne: true},
      });
      if (!customer) {
        return res.status(400).json({
          success: false,
          message:
            'Customer not found. Create the customer and activate Premium membership before CSP enrollment.',
        });
      }
    }

    try {
      assertPremiumForCsp(customer);
    } catch (premiumError) {
      return res.status(premiumError.status || 400).json({
        success: false,
        message: premiumError.message,
        membershipType: customer?.membershipType || 'none',
      });
    }

    const existingActive = await CustomersailorProgram.findOne({
      customerId: customer._id,
      status: 'active',
    });
    if (existingActive) {
      const populated = await populateEnrollment(
        CustomersailorProgram.findById(existingActive._id),
      );
      return res.status(409).json({
        success: false,
        message: 'Customer is already enrolled in CSP.',
        enrollment: toEnrollmentDto(populated),
      });
    }

    let vendor = null;
    if (vendorId && mongoose.Types.ObjectId.isValid(vendorId)) {
      vendor = await Vendor.findById(vendorId);
      if (!vendor) {
        return res.status(404).json({
          success: false,
          message: 'Vendor not found.',
        });
      }
    } else {
      const vendorMobile =
        normalizeMobile(customer.mobile) ||
        normalizeMobile(mobile) ||
        String(customer.mobile || '').trim();
      if (!vendorMobile) {
        return res.status(400).json({
          success: false,
          message: 'Valid mobile is required to link/create CSP vendor.',
        });
      }

      vendor = await Vendor.findOne({mobile: vendorMobile});
      if (!vendor) {
        // Also try exact customer mobile string
        vendor = await Vendor.findOne({
          mobile: String(customer.mobile || '').trim(),
        });
      }
      if (!vendor) {
        vendor = await Vendor.create({
          name: String(customer.name || name || 'CSP Sailor').trim(),
          mobile: vendorMobile,
          email: String(customer.email || email || '').trim(),
          companyName: String(customer.companyName || companyName || '').trim(),
          address: String(customer.address || address || '').trim(),
          city: String(customer.city || city || '').trim(),
          state: String(customer.state || state || '').trim(),
          pincode: String(customer.pincode || pincode || '').trim(),
          country: 'India',
          website: `https://${prositeUrl}`,
          notes: 'Auto-created for Customer Sailor Program (CSP)',
        });
      }
    }

    if (vendor && prositeUrl && vendor.website !== `https://${prositeUrl}`) {
      vendor.website = `https://${prositeUrl}`;
      await vendor.save();
    }

    const vendorActive = await CustomersailorProgram.findOne({
      vendorId: vendor._id,
      status: 'active',
    });
    if (vendorActive) {
      return res.status(409).json({
        success: false,
        message: 'Vendor is already linked to another active CSP enrollment.',
      });
    }

    const sailorShare = Number.isFinite(Number(sailorSharePercent))
      ? Number(sailorSharePercent)
      : getsailorSharePercent();
    const platformShare = Number.isFinite(Number(platformSharePercent))
      ? Number(platformSharePercent)
      : getPlatformSharePercent();

        const enrollment = await CustomersailorProgram.create({
      customerId: customer._id,
      vendorId: vendor._id,
      status: 'active',
      sailorSharePercent: sailorShare,
      platformSharePercent: platformShare,
      displayName: String(customer.name || '').trim(),
      mobile: String(customer.mobile || '').trim(),
    });

    await syncApprovedApplicationForEnrollment(customer, enrollment, prositeUrl);

    const populated = await populateEnrollment(
      CustomersailorProgram.findById(enrollment._id),
    );

    return res.status(201).json({
      success: true,
      message: 'CSP sailor enrolled successfully.',
      enrollment: toEnrollmentDto(populated),
    });
  } catch (error) {
    console.error('enrollCsp error:', error);
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'CSP enrollment already exists for this customer or vendor.',
      });
    }
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to enroll CSP sailor.',
    });
  }
};

/**
 * PATCH /csp/:id
 * Activate / deactivate or update share percents / display.
 */
export const updateCsp = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid CSP enrollment id.',
      });
    }

    const enrollment = await CustomersailorProgram.findById(id);
    if (!enrollment) {
      return res.status(404).json({
        success: false,
        message: 'CSP enrollment not found.',
      });
    }

    const {
      status,
      sailorSharePercent,
      platformSharePercent,
      displayName,
      mobile,
    } = req.body || {};

    if (status !== undefined) {
      const next = String(status).trim().toLowerCase();
      if (!['active', 'inactive'].includes(next)) {
        return res.status(400).json({
          success: false,
          message: 'status must be active or inactive.',
        });
      }
      if (next === 'active') {
        const customer = await Customer.findOne({
          _id: enrollment.customerId,
          isDeleted: {$ne: true},
        }).select('membershipType name');
        try {
          assertPremiumForCsp(customer);
        } catch (premiumError) {
          return res.status(premiumError.status || 400).json({
            success: false,
            message: premiumError.message,
            membershipType: customer?.membershipType || 'none',
          });
        }

        const clashCustomer = await CustomersailorProgram.findOne({
          _id: {$ne: enrollment._id},
          customerId: enrollment.customerId,
          status: 'active',
        });
        if (clashCustomer) {
          return res.status(409).json({
            success: false,
            message: 'Another active CSP enrollment exists for this customer.',
          });
        }
        const clashVendor = await CustomersailorProgram.findOne({
          _id: {$ne: enrollment._id},
          vendorId: enrollment.vendorId,
          status: 'active',
        });
        if (clashVendor) {
          return res.status(409).json({
            success: false,
            message: 'Another active CSP enrollment exists for this vendor.',
          });
        }
      }
      enrollment.status = next;
    }

    if (sailorSharePercent !== undefined) {
      const n = Number(sailorSharePercent);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return res.status(400).json({
          success: false,
          message: 'sailorSharePercent must be 0–100.',
        });
      }
      enrollment.sailorSharePercent = n;
    }

    if (platformSharePercent !== undefined) {
      const n = Number(platformSharePercent);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return res.status(400).json({
          success: false,
          message: 'platformSharePercent must be 0–100.',
        });
      }
      enrollment.platformSharePercent = n;
    }

    if (displayName !== undefined) {
      enrollment.displayName = String(displayName ?? '').trim();
    }
    if (mobile !== undefined) {
      enrollment.mobile = String(mobile ?? '').trim();
    }

    await enrollment.save();
    const populated = await populateEnrollment(
      CustomersailorProgram.findById(enrollment._id),
    );

    return res.status(200).json({
      success: true,
      message: 'CSP enrollment updated successfully.',
      enrollment: toEnrollmentDto(populated),
    });
  } catch (error) {
    console.error('updateCsp error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to update CSP enrollment.',
    });
  }
};

/**
 * Create the active CSP enrollment used after an application is approved.
 * Does not require Premium membership; staff enroll still does.
 */
export const activateEnrollmentForCustomer = async (customer, extras = {}) => {
  const existingActive = await CustomersailorProgram.findOne({
    customerId: customer._id,
    status: 'active',
  });
  if (existingActive) return existingActive;

  const vendorMobile =
    normalizeMobile(customer.mobile) || String(customer.mobile || '').trim();
  if (!vendorMobile) {
    const error = new Error(
      'Customer mobile is required to approve this CSP application.',
    );
    error.status = 400;
    throw error;
  }

  let vendor = await Vendor.findOne({mobile: vendorMobile});
  if (!vendor && customer.mobile) {
    vendor = await Vendor.findOne({
      mobile: String(customer.mobile).trim(),
    });
  }
  if (!vendor) {
    vendor = await Vendor.create({
      name: String(customer.name || 'CSP Sailor').trim(),
      mobile: vendorMobile,
      email: String(customer.email || '').trim(),
      companyName: String(extras.companyName || extras.brandName || '').trim(),
      brandName: String(extras.brandName || '').trim(),
      website: extras.prositeUrl
        ? `https://${String(extras.prositeUrl).replace(/^https?:\/\//i, '')}`
        : '',
      country: 'India',
      notes: 'Auto-created when a CSP application was approved',
    });
  }

  const vendorActive = await CustomersailorProgram.findOne({
    vendorId: vendor._id,
    status: 'active',
  });
  if (vendorActive) {
    const error = new Error(
      'Vendor is already linked to another active CSP enrollment.',
    );
    error.status = 409;
    throw error;
  }

  return CustomersailorProgram.create({
    customerId: customer._id,
    vendorId: vendor._id,
    status: 'active',
    sailorSharePercent: getsailorSharePercent(),
    platformSharePercent: getPlatformSharePercent(),
    displayName: String(customer.name || '').trim(),
    mobile: String(customer.mobile || '').trim(),
  });
};

const fallbackProsite = customer => {
  const slug =
    String(customer?.name || 'partner')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 40) || 'partner';
  return `1atives.com/pro/${slug}`;
};

/** Admin enroll is an active partner, so the customer program opens without Apply. */
export const syncApprovedApplicationForEnrollment = async (
  customer,
  enrollment,
  prositeUrlRaw = '',
) => {
  let prositeUrl = normalizePrositeUrl(prositeUrlRaw);
  if (!prositeUrl && enrollment?.vendorId) {
    const vendor = await Vendor.findById(enrollment.vendorId)
      .select('website')
      .lean();
    prositeUrl = normalizePrositeUrl(vendor?.website);
  }
  if (!prositeUrl) prositeUrl = fallbackProsite(customer);

  const brandName = String(customer?.name || 'CSP Partner').trim() || 'CSP Partner';
  let application = await CspApplication.findOne({customerId: customer._id}).sort({
    createdAt: -1,
  });

  if (!application) {
    return CspApplication.create({
      customerId: customer._id,
      brandName,
      categories: [],
      prositeUrl,
      alreadySelling: false,
      sellingPlatforms: [],
      status: 'approved',
      rejectionReason: '',
      reviewedAt: new Date(),
      enrollmentId: enrollment._id,
    });
  }

  application.status = 'approved';
  application.rejectionReason = '';
  application.reviewedAt = new Date();
  application.enrollmentId = enrollment._id;
  if (!application.brandName) application.brandName = brandName;
  if (normalizePrositeUrl(prositeUrlRaw) || !application.prositeUrl) {
    application.prositeUrl = prositeUrl;
  }
  await application.save();
  return application;
};

export const applicationForActiveEnrollment = async customer => {
  const enrollment = await CustomersailorProgram.findOne({
    customerId: customer._id,
    status: 'active',
  });
  if (!enrollment) return null;
  return syncApprovedApplicationForEnrollment(customer, enrollment);
};

const roundMoney = value => Math.round((Number(value) || 0) * 100) / 100;

const textOrEmpty = value => String(value || '').trim();

const emptyCspProgram = () => ({
  enrolled: false,
  applicationStatus: '',
  rejectionReason: '',
  brandName: '',
  prositeUrl: '',
  status: '',
  joinDate: null,
  performance: {
    productsSold: 0,
    totalEarnings: 0,
    salesAmount: 0,
    pendingPayout: 0,
    completedPayout: 0,
    availableBalance: 0,
  },
  products: [],
  sales: [],
  payouts: [],
  timeline: [],
});

const collectCspPartnerDetails = async (enrollment, {activityLimit = 200} = {}) => {
  const dto = toEnrollmentDto(enrollment);
  const customerId = dto.customerId ? String(dto.customerId) : '';
  let customerDoc = dto.customer ? (dto.customer.toObject ? dto.customer.toObject() : {...dto.customer}) : null;
  if (!customerDoc && customerId && mongoose.Types.ObjectId.isValid(customerId)) {
    customerDoc = await Customer.findById(customerId)
      .select('name mobile email walletAmount membershipType membershipPlanId membershipPurchase withdrawable affiliateBalance nonWithdrawable cashbackBalance closingBalance')
      .lean();
  }
  if (customerDoc) {
    await attachMembershipExpiry([customerDoc]);
  }
  let planDisplayName = customerDoc?.membershipType || '';
  if (customerDoc?.membershipPlanId && mongoose.Types.ObjectId.isValid(String(customerDoc.membershipPlanId))) {
    const plan = await Membership.findById(customerDoc.membershipPlanId).select('displayName planId').lean();
    if (plan?.displayName) planDisplayName = plan.displayName;
  }
  const wallet = customerId
    ? await Wallet.findOne({customerId})
        .select(
          'withdrawable nonWithdrawable affiliateBalance cashbackBalance walletAmount balanceSchema',
        )
        .lean()
    : null;
  const buckets = resolveTwoBuckets(wallet, dto.customer);

  let application = await CspApplication.findOne({
    enrollmentId: enrollment._id,
  }).lean();
  if (!application && customerId) {
    application = await CspApplication.findOne({customerId})
      .sort({createdAt: -1})
      .lean();
  }

  let vendor = dto.vendor ? (dto.vendor.toObject ? dto.vendor.toObject() : {...dto.vendor}) : null;
  if (!vendor && enrollment.vendorId && mongoose.Types.ObjectId.isValid(String(enrollment.vendorId))) {
    vendor = await Vendor.findById(enrollment.vendorId).lean();
  }

  const products = await Product.find({
    isCsp: true,
    cspEnrollmentId: enrollment._id,
  })
    .select(
      'productName serviceName category sellingPrice stockQty discountType discountValue createdAt updatedAt imageUrl images',
    )
    .sort({createdAt: -1})
    .lean();

  const productMap = new Map();
  const productNameMap = new Map();
  for (const prod of products) {
    const pId = String(prod._id);
    productMap.set(pId, prod);
    const pName = String(prod.productName || prod.serviceName || '').trim().toLowerCase();
    if (pName) productNameMap.set(pName, prod);
  }

  const resolveProductImage = (prodId, prodName) => {
    const prod = (prodId ? productMap.get(String(prodId)) : null) ||
      (prodName ? productNameMap.get(String(prodName).trim().toLowerCase()) : null);
    if (!prod) return null;
    const img =
      (typeof prod.imageUrl === 'string' && prod.imageUrl.trim()) ||
      (Array.isArray(prod.images) &&
        prod.images[0] &&
        typeof prod.images[0] === 'string' &&
        prod.images[0].trim()) ||
      '';
    return img || null;
  };

  // 1. Purchases & Purchase Orders for CSP
  const partnerNames = [
    dto.displayName,
    customerDoc?.name,
    vendor?.name,
    vendor?.companyName,
    vendor?.brandName,
    application?.brandName,
  ]
    .map(s => String(s || '').trim())
    .filter(Boolean);

  const partnerPhones = [
    dto.mobile,
    customerDoc?.mobile,
    vendor?.mobile,
    vendor?.businessPhoneNumber,
  ]
    .map(s => String(s || '').replace(/\D/g, '').slice(-10))
    .filter(p => p.length >= 10);

  const purchaseClauses = [];
  for (const name of [...new Set(partnerNames)]) {
    purchaseClauses.push({ supplierName: new RegExp(`^${escapeRegex(name)}$`, 'i') });
  }
  for (const phone of [...new Set(partnerPhones)]) {
    purchaseClauses.push({ supplierContact: new RegExp(phone.split('').join('\\D*')) });
  }

  let purchases = [];
  let purchaseOrders = [];
  if (purchaseClauses.length > 0) {
    [purchases, purchaseOrders] = await Promise.all([
      Purchase.find({ $or: purchaseClauses }).sort({ invoiceDate: -1, createdAt: -1 }).lean(),
      PurchaseOrder.find({ $or: purchaseClauses }).sort({ invoiceDate: -1, createdAt: -1 }).lean(),
    ]);
  }

  // 2. Sales & Settlements
  const settlements = await CspSettlement.find({
    'lines.cspEnrollmentId': enrollment._id,
  })
    .sort({settledAt: -1, createdAt: -1})
    .lean();

  const settlementInvoiceIds = settlements
    .map(s => s.invoiceId)
    .filter(id => id && mongoose.Types.ObjectId.isValid(String(id)));

  const [settlementInvoices, directCspInvoices] = await Promise.all([
    settlementInvoiceIds.length
      ? Invoice.find({ _id: { $in: settlementInvoiceIds } })
          .select('invoiceNumber invoiceCode customerName customerPhone status invoiceDate createdAt items')
          .lean()
      : [],
    Invoice.find({
      'items.cspEnrollmentId': enrollment._id,
      status: { $ne: 'cancelled' },
    })
      .select('invoiceNumber invoiceCode customerName customerPhone status invoiceDate createdAt items')
      .lean(),
  ]);

  const invoiceMap = new Map();
  const invoiceCodeMap = new Map();
  for (const inv of [...settlementInvoices, ...directCspInvoices]) {
    invoiceMap.set(String(inv._id), inv);
    if (inv.invoiceCode) invoiceCodeMap.set(String(inv.invoiceCode), inv);
  }

  const salesByProduct = new Map();
  const timelineEvents = [];
  const salesList = [];
  const processedInvoiceLineKeys = new Set();
  const successfulInvoiceCodes = new Set();

  let totalSalesAmount = 0;
  let totalProductsSold = 0;
  let totalEarnings = 0;

  // Process settlements
  for (const settlement of settlements) {
    if (settlement.status === 'reversed') {
      for (const line of settlement.lines || []) {
        if (String(line.cspEnrollmentId || '') !== String(enrollment._id)) continue;
        const inv = invoiceMap.get(String(settlement.invoiceId)) || invoiceCodeMap.get(String(settlement.invoiceCode));
        const prodName = textOrEmpty(line.productName) || 'CSP Product';
        const lineSales = Number(line.lineBaseAmount) || 0;
        timelineEvents.push({
          id: `reversed-${settlement._id}-${timelineEvents.length}`,
          kind: 'cancellation',
          type: 'sale_reversed',
          title: `Sale Reversed: ${prodName}`,
          subtitle: inv?.customerName ? `Customer: ${inv.customerName}` : 'Settlement reversed',
          idRef: textOrEmpty(settlement.invoiceCode),
          productName: prodName,
          customerName: inv?.customerName || '',
          quantity: 1,
          unitPrice: roundMoney(lineSales),
          amount: roundMoney(lineSales),
          date: settlement.updatedAt || settlement.settledAt || settlement.createdAt,
          status: 'reversed',
          details: {
            invoiceCode: settlement.invoiceCode,
            customerName: inv?.customerName || '',
            reason: 'Settlement reversed',
          },
        });
      }
      continue;
    }

    const inv = invoiceMap.get(String(settlement.invoiceId)) || invoiceCodeMap.get(String(settlement.invoiceCode));

    for (const line of settlement.lines || []) {
      if (String(line.cspEnrollmentId || '') !== String(enrollment._id)) continue;

      const lineSales = Number(line.lineBaseAmount) || 0;
      const lineEarnings = Number(line.sailorAmount) || 0;
      const prodIdStr = line.productId ? String(line.productId) : '';
      const prodName = textOrEmpty(line.productName) || 'CSP Product';

      const matchedItem = inv?.items?.find(i =>
        (prodIdStr && String(i.productId) === prodIdStr) ||
        (i.productName && i.productName.trim().toLowerCase() === prodName.toLowerCase())
      );

      const qty = Number(matchedItem?.qty) || 1;
      const unitPrice = Number(matchedItem?.unitPrice) || roundMoney(lineSales / qty);
      const saleDate = settlement.settledAt || inv?.invoiceDate || inv?.createdAt || settlement.createdAt;
      const customerName = inv?.customerName || 'Customer';
      const customerPhone = inv?.customerPhone || '';
      const invoiceCode = settlement.invoiceCode || inv?.invoiceCode || 'Sale';
      const image = resolveProductImage(prodIdStr, prodName);

      const lineKey = `${invoiceCode}_${prodIdStr || prodName.toLowerCase()}`;
      processedInvoiceLineKeys.add(lineKey);

      totalProductsSold += qty;
      totalSalesAmount += lineSales;
      totalEarnings += lineEarnings;
      successfulInvoiceCodes.add(invoiceCode);

      const prodKey = prodIdStr || prodName.toLowerCase();
      const current = salesByProduct.get(prodKey) || { sold: 0, sales: 0 };
      current.sold += qty;
      current.sales += lineSales;
      salesByProduct.set(prodKey, current);

      const saleRecord = {
        id: `sale-${settlement._id}-${salesList.length}`,
        invoiceCode,
        invoiceNumber: inv?.invoiceNumber || invoiceCode,
        customerName,
        customerPhone,
        productId: prodIdStr || null,
        productName: prodName,
        image,
        category: matchedItem?.category || (prodIdStr ? productMap.get(prodIdStr)?.category : '') || '',
        quantity: qty,
        unitPrice: roundMoney(unitPrice),
        totalAmount: roundMoney(lineSales),
        sailorEarnings: roundMoney(lineEarnings),
        saleDate,
        status: 'completed',
      };
      salesList.push(saleRecord);

      timelineEvents.push({
        id: `timeline-sale-${settlement._id}-${timelineEvents.length}`,
        kind: 'sale',
        type: 'product_sold',
        title: `Product Sold: ${prodName}`,
        subtitle: customerName ? `Sold to ${customerName}` : 'Customer sale',
        idRef: invoiceCode,
        productName: prodName,
        customerName,
        quantity: qty,
        unitPrice: roundMoney(unitPrice),
        amount: roundMoney(lineSales),
        sailorEarnings: roundMoney(lineEarnings),
        date: saleDate,
        status: 'completed',
        image,
        details: {
          invoiceCode,
          customerName,
          customerPhone,
          quantity: qty,
          unitPrice: roundMoney(unitPrice),
          totalAmount: roundMoney(lineSales),
          sailorEarnings: roundMoney(lineEarnings),
          status: 'completed',
        },
      });
    }
  }

  // Process direct CSP invoices not yet settled
  for (const inv of directCspInvoices) {
    if (inv.status === 'cancelled') continue;
    const invoiceCode = inv.invoiceCode || `INV-${inv.invoiceNumber}`;

    for (const item of inv.items || []) {
      if (String(item.cspEnrollmentId || '') !== String(enrollment._id)) continue;
      const prodIdStr = item.productId ? String(item.productId) : '';
      const prodName = textOrEmpty(item.productName) || 'CSP Product';
      const lineKey = `${invoiceCode}_${prodIdStr || prodName.toLowerCase()}`;
      if (processedInvoiceLineKeys.has(lineKey)) continue;
      processedInvoiceLineKeys.add(lineKey);

      const qty = Number(item.qty) || 1;
      const unitPrice = Number(item.unitPrice) || 0;
      const lineSales = Number(item.lineTotal) || roundMoney(qty * unitPrice);
      const lineEarnings = Number(item.cspsailorAmount) || roundMoney(lineSales * 0.7);
      const saleDate = inv.invoiceDate || inv.createdAt;
      const customerName = inv.customerName || 'Customer';
      const customerPhone = inv.customerPhone || '';
      const image = resolveProductImage(prodIdStr, prodName);

      totalProductsSold += qty;
      totalSalesAmount += lineSales;
      totalEarnings += lineEarnings;
      successfulInvoiceCodes.add(invoiceCode);

      const prodKey = prodIdStr || prodName.toLowerCase();
      const current = salesByProduct.get(prodKey) || { sold: 0, sales: 0 };
      current.sold += qty;
      current.sales += lineSales;
      salesByProduct.set(prodKey, current);

      const saleRecord = {
        id: `sale-inv-${inv._id}-${salesList.length}`,
        invoiceCode,
        invoiceNumber: inv.invoiceNumber || invoiceCode,
        customerName,
        customerPhone,
        productId: prodIdStr || null,
        productName: prodName,
        image,
        category: item.category || '',
        quantity: qty,
        unitPrice: roundMoney(unitPrice),
        totalAmount: roundMoney(lineSales),
        sailorEarnings: roundMoney(lineEarnings),
        saleDate,
        status: 'completed',
      };
      salesList.push(saleRecord);

      timelineEvents.push({
        id: `timeline-sale-inv-${inv._id}-${timelineEvents.length}`,
        kind: 'sale',
        type: 'product_sold',
        title: `Product Sold: ${prodName}`,
        subtitle: customerName ? `Sold to ${customerName}` : 'Customer sale',
        idRef: invoiceCode,
        productName: prodName,
        customerName,
        quantity: qty,
        unitPrice: roundMoney(unitPrice),
        amount: roundMoney(lineSales),
        sailorEarnings: roundMoney(lineEarnings),
        date: saleDate,
        status: 'completed',
        image,
        details: {
          invoiceCode,
          customerName,
          customerPhone,
          quantity: qty,
          unitPrice: roundMoney(unitPrice),
          totalAmount: roundMoney(lineSales),
          sailorEarnings: roundMoney(lineEarnings),
          status: 'completed',
        },
      });
    }
  }

  // 3. Process Purchases
  for (const p of purchases) {
    const isCancelled = String(p.status || '').toLowerCase() === 'cancelled';
    const pItems = Array.isArray(p.items) ? p.items : [];
    const totalQty = pItems.reduce((acc, item) => acc + (Number(item.qty) || 0), 0) || 1;
    const prodName = pItems.length > 0 ? pItems.map(i => i.productName).filter(Boolean).join(', ') : 'Purchase item';
    const unitPrice = pItems.length === 1 ? (Number(pItems[0].unitPrice) || 0) : roundMoney((Number(p.amount) || 0) / totalQty);
    const pDate = p.invoiceDate || p.vendorDate || p.createdAt;
    const pIdRef = p.invoiceNumber || String(p._id);

    if (isCancelled) {
      timelineEvents.push({
        id: `timeline-purchase-cancel-${p._id}`,
        kind: 'cancellation',
        type: 'purchase_cancellation',
        title: `Purchase Cancelled: ${pIdRef}`,
        subtitle: prodName,
        idRef: pIdRef,
        productName: prodName,
        customerName: p.supplierName || '',
        quantity: totalQty,
        unitPrice: roundMoney(unitPrice),
        amount: roundMoney(p.amount),
        date: p.updatedAt || pDate,
        status: 'cancelled',
        details: {
          invoiceNumber: p.invoiceNumber,
          supplierName: p.supplierName,
          items: pItems.map(i => ({
            productName: i.productName,
            qty: Number(i.qty) || 0,
            unitPrice: Number(i.unitPrice) || 0,
            lineTotal: Number(i.lineTotal) || 0,
          })),
          notes: p.notes || '',
          status: 'cancelled',
        },
      });
    } else {
      timelineEvents.push({
        id: `timeline-purchase-${p._id}`,
        kind: 'purchase',
        type: 'purchase_created',
        title: `Purchase Created: ${pIdRef}`,
        subtitle: prodName,
        idRef: pIdRef,
        productName: prodName,
        customerName: p.supplierName || '',
        quantity: totalQty,
        unitPrice: roundMoney(unitPrice),
        amount: roundMoney(p.amount),
        date: pDate,
        status: p.status || 'completed',
        details: {
          invoiceNumber: p.invoiceNumber,
          supplierName: p.supplierName,
          paidAmount: roundMoney(p.paidAmount),
          dueAmount: roundMoney(p.dueAmount),
          items: pItems.map(i => ({
            productName: i.productName,
            qty: Number(i.qty) || 0,
            unitPrice: Number(i.unitPrice) || 0,
            lineTotal: Number(i.lineTotal) || 0,
          })),
          paymentMode: p.paymentMode || '',
          notes: p.notes || '',
          status: p.status,
        },
      });
    }
  }

  // 4. Process Purchase Orders
  for (const po of purchaseOrders) {
    const isCancelled = String(po.status || po.orderStatus || '').toLowerCase() === 'cancelled';
    const poItems = Array.isArray(po.items) ? po.items : [];
    const totalQty = poItems.reduce((acc, item) => acc + (Number(item.qty) || 0), 0) || 1;
    const prodName = poItems.length > 0 ? poItems.map(i => i.productName).filter(Boolean).join(', ') : 'Purchase order item';
    const unitPrice = poItems.length === 1 ? (Number(poItems[0].unitPrice) || 0) : roundMoney((Number(po.amount) || 0) / totalQty);
    const poDate = po.invoiceDate || po.createdAt;
    const poIdRef = po.invoiceNumber || String(po._id);

    if (isCancelled) {
      timelineEvents.push({
        id: `timeline-po-cancel-${po._id}`,
        kind: 'cancellation',
        type: 'order_cancellation',
        title: `PO Cancelled: ${poIdRef}`,
        subtitle: prodName,
        idRef: poIdRef,
        productName: prodName,
        customerName: po.supplierName || '',
        quantity: totalQty,
        unitPrice: roundMoney(unitPrice),
        amount: roundMoney(po.amount),
        date: po.updatedAt || poDate,
        status: 'cancelled',
        details: {
          invoiceNumber: po.invoiceNumber,
          supplierName: po.supplierName,
          items: poItems.map(i => ({
            productName: i.productName,
            qty: Number(i.qty) || 0,
            unitPrice: Number(i.unitPrice) || 0,
            lineTotal: Number(i.lineTotal) || 0,
          })),
          notes: po.notes || '',
          status: 'cancelled',
        },
      });
    } else {
      timelineEvents.push({
        id: `timeline-po-${po._id}`,
        kind: 'purchase',
        type: 'purchase_order',
        title: `Purchase Order: ${poIdRef}`,
        subtitle: prodName,
        idRef: poIdRef,
        productName: prodName,
        customerName: po.supplierName || '',
        quantity: totalQty,
        unitPrice: roundMoney(unitPrice),
        amount: roundMoney(po.amount),
        date: poDate,
        status: po.orderStatus || po.status || 'pending',
        details: {
          invoiceNumber: po.invoiceNumber,
          supplierName: po.supplierName,
          items: poItems.map(i => ({
            productName: i.productName,
            qty: Number(i.qty) || 0,
            unitPrice: Number(i.unitPrice) || 0,
            lineTotal: Number(i.lineTotal) || 0,
          })),
          notes: po.notes || '',
          status: po.orderStatus || po.status,
        },
      });
    }
  }

  // 5. Stock Updates (Product additions & inventory)
  for (const prod of products) {
    const prodName = textOrEmpty(prod.productName) || textOrEmpty(prod.serviceName) || 'Product';
    const stockQty = Number(prod.stockQty) || 0;
    const image = resolveProductImage(String(prod._id), prodName);

    if (prod.createdAt) {
      timelineEvents.push({
        id: `timeline-stock-${prod._id}`,
        kind: 'stock_add',
        type: 'product_added',
        title: `Stock Added: ${prodName}`,
        subtitle: prod.category ? `Category: ${prod.category} · Initial stock: ${stockQty}` : `Initial stock: ${stockQty}`,
        idRef: String(prod._id),
        productName: prodName,
        quantity: stockQty,
        unitPrice: roundMoney(prod.sellingPrice),
        amount: roundMoney(stockQty * (Number(prod.sellingPrice) || 0)),
        date: prod.createdAt,
        status: 'available',
        image,
        details: {
          productId: String(prod._id),
          productName: prodName,
          category: prod.category || '',
          stockQty,
          sellingPrice: roundMoney(prod.sellingPrice),
        },
      });
    }
  }

  // 6. Payouts / Withdrawals
  const withdrawals = customerId
    ? await WalletWithdrawal.find({customer: customerId})
        .sort({createdAt: -1})
        .limit(50)
        .lean()
    : [];

  const pendingStatuses = new Set(['requested', 'under_review', 'approved']);
  let pendingPayout = 0;
  let completedPayout = 0;
  const payouts = withdrawals.map(row => {
    const amount = Number(row.amount) || 0;
    if (pendingStatuses.has(row.status)) pendingPayout += amount;
    if (row.status === 'paid') completedPayout += amount;

    const isPaid = row.status === 'paid';
    const isRejected = row.status === 'rejected' || row.status === 'cancelled';

    timelineEvents.push({
      id: `timeline-payout-${row._id}`,
      kind: isRejected ? 'cancellation' : 'payout',
      type: isPaid ? 'payout_completed' : isRejected ? 'payout_rejected' : 'payout_requested',
      title: isPaid
        ? `Payout Completed: ${textOrEmpty(row.method).toUpperCase() || 'BANK'}`
        : isRejected
        ? `Payout Rejected: ${textOrEmpty(row.method).toUpperCase() || 'BANK'}`
        : `Payout Requested: ${textOrEmpty(row.method).toUpperCase() || 'BANK'}`,
      subtitle: `Status: ${row.status || 'pending'}`,
      idRef: String(row._id),
      amount: roundMoney(amount),
      date: row.paidAt || row.reviewedAt || row.createdAt || null,
      status: row.status || 'pending',
      details: {
        amount: roundMoney(amount),
        method: textOrEmpty(row.method),
        status: row.status || '',
      },
    });

    return {
      id: String(row._id),
      amount: roundMoney(amount),
      status: row.status || '',
      method: textOrEmpty(row.method),
      at: row.paidAt || row.createdAt || null,
    };
  });

  // Sort Sales by saleDate descending
  salesList.sort((a, b) => {
    const left = a.saleDate ? new Date(a.saleDate).getTime() : 0;
    const right = b.saleDate ? new Date(b.saleDate).getTime() : 0;
    return right - left;
  });

  // Sort Timeline events by date descending
  timelineEvents.sort((a, b) => {
    const left = a.date ? new Date(a.date).getTime() : 0;
    const right = b.date ? new Date(b.date).getTime() : 0;
    return right - left;
  });

  const prositeUrl = textOrEmpty(application?.prositeUrl);
  const website =
    textOrEmpty(dto.vendor?.website) ||
    (prositeUrl ? `https://${prositeUrl.replace(/^https?:\/\//i, '')}` : '');

  const timeline = activityLimit > 0 ? timelineEvents.slice(0, activityLimit) : timelineEvents;

  return {
    partner: {
      fullName: textOrEmpty(dto.displayName),
      email:
        textOrEmpty(dto.customer?.email) ||
        textOrEmpty(dto.vendor?.email) ||
        textOrEmpty(dto.vendor?.businessEmail),
      phone: textOrEmpty(dto.mobile),
      website,
      prositeUrl,
      status: textOrEmpty(dto.status) || 'inactive',
      joinDate: enrollment.createdAt || null,
      brandName:
        textOrEmpty(application?.brandName) ||
        textOrEmpty(dto.vendor?.companyName) ||
        textOrEmpty(dto.vendor?.name),
      categories: Array.isArray(application?.categories)
        ? application.categories.filter(Boolean)
        : [],
      membershipType: textOrEmpty(planDisplayName || customerDoc?.membershipType),
      membershipEndDate: customerDoc?.membershipEndDate || null,
      membershipExpired: Boolean(customerDoc?.membershipExpired),
      sailorSharePercent:
        dto.sailorSharePercent == null ? null : Number(dto.sailorSharePercent),
      platformSharePercent:
        dto.platformSharePercent == null
          ? null
          : Number(dto.platformSharePercent),
    },
    performance: {
      productsSold: totalProductsSold,
      totalEarnings: roundMoney(totalEarnings),
      salesAmount: roundMoney(totalSalesAmount),
      successfulTransactionsCount: successfulInvoiceCodes.size,
      pendingPayout: roundMoney(pendingPayout),
      completedPayout: roundMoney(completedPayout),
      availableBalance: roundMoney(buckets.withdrawable),
      totalLeads: null,
    },
    products: products.map(product => {
      const key = String(product._id);
      const nameKey = String(product.productName || product.serviceName || '').trim().toLowerCase();
      const sales = salesByProduct.get(key) || salesByProduct.get(nameKey) || {sold: 0, sales: 0};
      const image = resolveProductImage(key, product.productName || product.serviceName);
      return {
        id: key,
        name:
          textOrEmpty(product.productName) ||
          textOrEmpty(product.serviceName),
        category: textOrEmpty(product.category),
        price: roundMoney(product.sellingPrice),
        stock: Number(product.stockQty) || 0,
        sold: sales.sold,
        sales: roundMoney(sales.sales),
        image: image || null,
        imageUrl: image || null,
        images: Array.isArray(product.images) ? product.images : (image ? [image] : []),
        createdAt: product.createdAt || null,
      };
    }),
    payouts,
    sales: salesList,
    timeline,
    activity: timeline,
  };
};

export const cspProgramForCustomer = async customerId => {
  if (!customerId || !mongoose.Types.ObjectId.isValid(String(customerId))) {
    return emptyCspProgram();
  }

  const enrollment = await populateEnrollment(
    CustomersailorProgram.findOne({customerId}).sort({status: 1, createdAt: -1}),
  );
  const application = await CspApplication.findOne({customerId})
    .sort({createdAt: -1})
    .lean();

  if (!enrollment) {
    return {
      ...emptyCspProgram(),
      applicationStatus: textOrEmpty(application?.status),
      rejectionReason: textOrEmpty(application?.rejectionReason),
      brandName: textOrEmpty(application?.brandName),
      prositeUrl: textOrEmpty(application?.prositeUrl),
    };
  }

  const details = await collectCspPartnerDetails(enrollment, {activityLimit: 40});
  return {
    enrolled: true,
    applicationStatus:
      textOrEmpty(application?.status) ||
      (enrollment.status === 'active' ? 'approved' : ''),
    rejectionReason: textOrEmpty(application?.rejectionReason),
    brandName: details.partner.brandName,
    prositeUrl: details.partner.prositeUrl,
    status: details.partner.status,
    joinDate: details.partner.joinDate,
    performance: details.performance,
    products: details.products,
    sales: details.sales,
    payouts: details.payouts,
    timeline: details.timeline,
  };
};

/**
 * GET /csp/:id/details
 * Partner profile plus the CSP records that already exist for that enrollment.
 */
export const getCspPartnerDetails = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid CSP partner id.',
      });
    }

    const enrollment = await populateEnrollment(
      CustomersailorProgram.findById(id),
    );
    if (!enrollment) {
      return res.status(404).json({
        success: false,
        message: 'CSP partner not found.',
      });
    }

    const details = await collectCspPartnerDetails(enrollment);
    return res.status(200).json({
      success: true,
      ...details,
    });
  } catch (error) {
    console.error('getCspPartnerDetails error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch CSP partner details.',
    });
  }
};

/** @deprecated Use enrollCsp — kept for older clients that posted name/phone only. */
export const postCsp = enrollCsp;

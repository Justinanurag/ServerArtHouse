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
      'name mobile email walletAmount membershipType withdrawable affiliateBalance nonWithdrawable cashbackBalance closingBalance',
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

    const enrollments = rows.map(row => {
      const dto = toEnrollmentDto(row);
      const customerId = dto.customerId ? String(dto.customerId) : '';
      const wallet = customerId ? walletMap.get(customerId) : null;
      const buckets = resolveTwoBuckets(wallet, dto.customer);
      return {
        ...dto,
        withdrawable: buckets.withdrawable,
        withdrawableBalance: buckets.withdrawable,
        affiliateBalance: buckets.withdrawable,
        nonWithdrawable: buckets.nonWithdrawable,
        walletAmount: buckets.total,
      };
    });

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

const collectCspPartnerDetails = async (enrollment, {activityLimit = 8} = {}) => {
  const dto = toEnrollmentDto(enrollment);
    const customerId = dto.customerId ? String(dto.customerId) : '';
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

    const products = await Product.find({
      isCsp: true,
      cspEnrollmentId: enrollment._id,
    })
      .select(
        'productName serviceName category sellingPrice stockQty discountType discountValue createdAt',
      )
      .sort({createdAt: -1})
      .lean();

    const settlements = await CspSettlement.find({
      'lines.cspEnrollmentId': enrollment._id,
    })
      .sort({settledAt: -1})
      .limit(40)
      .lean();

    const withdrawals = customerId
      ? await WalletWithdrawal.find({customer: customerId})
          .sort({createdAt: -1})
          .limit(20)
          .lean()
      : [];

    const salesByProduct = new Map();
    const activity = [];
    let productsSold = 0;
    let salesAmount = 0;
    let totalEarnings = 0;

    for (const settlement of settlements) {
      if (settlement.status === 'reversed') continue;
      for (const line of settlement.lines || []) {
        if (String(line.cspEnrollmentId || '') !== String(enrollment._id)) {
          continue;
        }
        const lineSales = Number(line.lineBaseAmount) || 0;
        const lineEarnings = Number(line.sailorAmount) || 0;
        productsSold += 1;
        salesAmount += lineSales;
        totalEarnings += lineEarnings;
        const key = String(line.productId || line.productName || 'product');
        const current = salesByProduct.get(key) || {
          sold: 0,
          sales: 0,
        };
        current.sold += 1;
        current.sales += lineSales;
        salesByProduct.set(key, current);
        activity.push({
          id: `sale-${settlement._id}-${activity.length}`,
          kind: 'sale',
          title: textOrEmpty(line.productName) || 'Product sale',
          amount: roundMoney(lineSales),
          at: settlement.settledAt || settlement.createdAt || null,
          detail: textOrEmpty(settlement.invoiceCode),
          status: 'settled',
        });
      }
    }

    const pendingStatuses = new Set(['requested', 'under_review', 'approved']);
    let pendingPayout = 0;
    let completedPayout = 0;
    const payouts = withdrawals.map(row => {
      const amount = Number(row.amount) || 0;
      if (pendingStatuses.has(row.status)) pendingPayout += amount;
      if (row.status === 'paid') completedPayout += amount;
      activity.push({
        id: `payout-${row._id}`,
        kind: 'payout',
        title: 'Payout',
        amount: roundMoney(amount),
        at: row.paidAt || row.reviewedAt || row.createdAt || null,
        detail: textOrEmpty(row.method).toUpperCase(),
        status: row.status || '',
      });
      return {
        id: String(row._id),
        amount: roundMoney(amount),
        status: row.status || '',
        method: textOrEmpty(row.method),
        at: row.paidAt || row.createdAt || null,
      };
    });

    activity.sort((a, b) => {
      const left = a.at ? new Date(a.at).getTime() : 0;
      const right = b.at ? new Date(b.at).getTime() : 0;
      return right - left;
    });

    const prositeUrl = textOrEmpty(application?.prositeUrl);
    const website =
      textOrEmpty(dto.vendor?.website) ||
      (prositeUrl ? `https://${prositeUrl.replace(/^https?:\/\//i, '')}` : '');

    const timeline = activity.slice(0, activityLimit);
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
        membershipType: textOrEmpty(dto.customer?.membershipType),
        sailorSharePercent:
          dto.sailorSharePercent == null ? null : Number(dto.sailorSharePercent),
        platformSharePercent:
          dto.platformSharePercent == null
            ? null
            : Number(dto.platformSharePercent),
      },
      performance: {
        productsSold,
        totalEarnings: roundMoney(totalEarnings),
        salesAmount: roundMoney(salesAmount),
        pendingPayout: roundMoney(pendingPayout),
        completedPayout: roundMoney(completedPayout),
        availableBalance: roundMoney(buckets.withdrawable),
        totalLeads: null,
      },
      products: products.map(product => {
        const key = String(product._id);
        const sales = salesByProduct.get(key) || {sold: 0, sales: 0};
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
          createdAt: product.createdAt || null,
        };
      }),
      payouts,
      sales: timeline.filter(row => row.kind === 'sale'),
      timeline,
      activity: timeline,
    };
};

/**
 * CSP products, sales, payouts, and timeline for one customer.
 * Used by Customer 360. Returns an empty program when they are not enrolled.
 */
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

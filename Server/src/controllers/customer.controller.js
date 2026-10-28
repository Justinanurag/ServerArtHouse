import mongoose from 'mongoose';
import Customer from '../models/customer.model.js';
import Wallet from '../models/wallet.model.js';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import { uploadOnCloudinary } from '../utils/cloudinary.js';
import { sendNewAccountWhatsApp } from '../modules/customer/services/whatsapp.service.js';
import {attachMembershipExpiry} from '../services/membershipEligibility.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const localUploadsDir = path.resolve(__dirname, '../../uploads/customers');
const tmpUploadsDir = path.join('/tmp', 'uploads', 'customers');

let uploadsDir = localUploadsDir;
try {
  fs.mkdirSync(localUploadsDir, {recursive: true});
} catch (error) {
  // Fallback for read-only runtime filesystems (common in serverless envs).
  fs.mkdirSync(tmpUploadsDir, {recursive: true});
  uploadsDir = tmpUploadsDir;
}

// Storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueName =
      Date.now() + '-' + file.originalname.replace(/\s+/g, '');
    cb(null, uniqueName);
  },
});

// File filter (only images)
const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|webp/;
  const isValid = allowedTypes.test(file.mimetype);

  if (isValid) cb(null, true);
  else cb(new Error('Only image files allowed'), false);
};

export const uploadCustomerImage = multer({
  storage,
  fileFilter,
  limits: {fileSize: 2 * 1024 * 1024}, // 2MB
});

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const validMemberships = [
  'none',
  'pro',
  'premium',
  'special',
  'junior',
  'general',
];

const validGenders = ['male', 'female', 'other'];
const optionalGenderValues = new Set([
  '',
  'not specified',
  'n/a',
  'na',
  'none',
  'null',
  'undefined',
]);

/** Gender is optional. Empty / "Not Specified" → "". Invalid non-empty → null. */
const normalizeGender = gender => {
  const genderVal = String(gender ?? '').trim().toLowerCase();
  if (optionalGenderValues.has(genderVal)) return '';
  if (validGenders.includes(genderVal)) return genderVal;
  return null;
};

/** Customer mobiles are stored as 10-digit Indian numbers (6–9…). */
const normalizeCustomerMobile = input => {
  const digits = String(input ?? '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) {
    const ten = digits.slice(2);
    return /^[6-9]\d{9}$/.test(ten) ? ten : null;
  }
  if (digits.length === 10 && /^[6-9]\d{9}$/.test(digits)) return digits;
  return null;
};

const findCustomerByMobile = async (mobile, excludeId = null) => {
  const query = {mobile, isDeleted: {$ne: true}};
  if (excludeId && mongoose.Types.ObjectId.isValid(excludeId)) {
    query._id = {$ne: excludeId};
  }
  return Customer.findOne(query)
    .select('_id name mobile email membershipType membershipPlanId priority')
    .lean();
};

/**
 * GET/POST /customer/check-phone
 * Body/query: mobile | phone | phoneNumber
 */
const checkCustomerPhone = async (req, res) => {
  try {
    const raw =
      req.body?.mobile ??
      req.body?.phone ??
      req.body?.phoneNumber ??
      req.query?.mobile ??
      req.query?.phone ??
      req.query?.phoneNumber ??
      '';
    const excludeId =
      req.body?.excludeId ?? req.query?.excludeId ?? null;

    const mobile = normalizeCustomerMobile(raw);
    if (!mobile) {
      return res.status(400).json({
        success: false,
        exists: false,
        available: false,
        message: 'Valid 10-digit mobile number is required.',
      });
    }

    const existing = await findCustomerByMobile(mobile, excludeId);
    if (existing) {
      return res.status(200).json({
        success: true,
        exists: true,
        available: false,
        message: 'A customer with this mobile number already exists.',
        customer: {
          id: existing._id,
          name: existing.name,
          mobile: existing.mobile,
          email: existing.email,
          membershipType: existing.membershipType,
        },
      });
    }

    return res.status(200).json({
      success: true,
      exists: false,
      available: true,
      message: 'Mobile number is available.',
      mobile,
    });
  } catch (error) {
    console.error('checkCustomerPhone error:', error);
    return res.status(500).json({
      success: false,
      exists: false,
      available: false,
      message: 'Failed to check mobile number.',
    });
  }
};

const createCustomer = async (req, res) => {
  try {
    const {
      name,
      mobile,
      email,
      gstin,
      companyName,
      address,
      pincode,
      city,
      state,
      country,
      adharNumber,
      dob,
      gender,
      whatsappNumber,
      AlternateMobile,
      IFSCcode,
      bankName,
      branchName,
      accountNumber,
      panNumber,
      accountHolderName,
      UPIID,
      membershipType
    } = req.body;
    console.log(req.body);

    if (!name || !mobile) {
      return res.status(400).json({
        success: false,
        message: 'Name and mobile are required.',
      });
    }

    const mobileNorm = normalizeCustomerMobile(mobile);
    if (!mobileNorm) {
      return res.status(400).json({
        success: false,
        message: 'Invalid mobile number',
      });
    }

    // Explicit duplicate check (before create / unique-index race)
    const existingMobile = await findCustomerByMobile(mobileNorm);
    if (existingMobile) {
      return res.status(409).json({
        success: false,
        exists: true,
        message: 'A customer with this mobile number already exists.',
        customer: {
          id: existingMobile._id,
          name: existingMobile.name,
          mobile: existingMobile.mobile,
        },
      });
    }

    const membership = (membershipType || 'none').toLowerCase()||'none';
    if (!validMemberships.includes(membership)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid membership type.',
      });
    }

    if (adharNumber && !/^\d{12}$/.test(String(adharNumber).trim())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Aadhar number',
      });
    }

    const panNorm = panNumber ? String(panNumber).trim().toUpperCase() : '';
    if (panNorm && !/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(panNorm)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid PAN number',
      });
    }

    const genderNorm = normalizeGender(gender);
    if (genderNorm === null) {
      return res.status(400).json({
        success: false,
        message: 'Invalid gender value.',
      });
    }

    let profileImage = req.file
      ? `/uploads/customers/${req.file.filename}`
      : '';

    if (req.file) {
      const cloudinaryUrl = await uploadOnCloudinary(req.file.path);
      if (cloudinaryUrl) {
        profileImage = cloudinaryUrl;
      }
    }

    const customer = await Customer.create({
      name: String(name).trim(),
      mobile: mobileNorm,
      email: String(email ?? '').trim(),
      gstin: String(gstin ?? '').trim(),
      companyName: String(companyName ?? '').trim(),
      address: String(address ?? '').trim(),
      pincode: String(pincode ?? '').trim(),
      city: String(city ?? '').trim(),
      state: String(state ?? '').trim(),
      country: String(country ?? '').trim(),

      membershipType: membership,

      adharNumber: String(adharNumber ?? '').trim(),
      dob: dob ? new Date(dob) : null,
      gender: genderNorm,
      whatsappNumber: String(whatsappNumber ?? '').trim(),
      AlternateMobile: String(AlternateMobile ?? '').trim(),

      IFSCcode: String(IFSCcode ?? '').trim(),
      bankName: String(bankName ?? '').trim(),
      branchName: String(branchName ?? '').trim(),
      accountNumber: String(accountNumber ?? '').trim(),
      panNumber: panNorm,
      accountHolderName: String(accountHolderName ?? '').trim(),
      UPIID: String(UPIID ?? '').trim(),

      profileImage,

      createdBy: {
        m_staff_id: req.user?.userId ?? null,
        m_staff_name: req.user?.m_staff_name ?? null,
        m_staff_email: req.user?.m_staff_email ?? null,
      },
    });

    // Never keep customerId:null (breaks unique customerId indexes)
    await Customer.updateOne(
      {_id: customer._id, customerId: null},
      {$unset: {customerId: 1}},
    );

    // Automatically create a wallet for the customer and credit ₹25 joining bonus
    await Wallet.create({
      customerId: customer._id,
      customerName: customer.name,
      customerPhone: customer.mobile,
      walletAmount: 25,
      transactions: [{
        type: "credit",
        amount: 25,
        note: "Joining Bonus",
        referenceType: "JoiningBonus",
        closingBalance: 25,
        createdBy: {
          m_staff_id: req.user?.userId ?? null,
          m_staff_name: req.user?.m_staff_name ?? req.user?.name ?? null,
          m_staff_email: req.user?.m_staff_email ?? req.user?.email ?? null,
        }
      }]
    });

    // Sync walletAmount and closingBalance in the Customer document
    const updatedCustomer = await Customer.findByIdAndUpdate(
      customer._id,
      {
        $set: {
          walletAmount: 25,
          closingBalance: 25,
        },
        $unset: {customerId: 1},
      },
      { new: true }
    );

    // Fire-and-forget Meta WhatsApp `newaccount` (do not block create response)
    // Label matches the ₹25 Joining Bonus credited above.
    const whatsappTo =
      String(updatedCustomer?.whatsappNumber || '').trim() ||
      String(updatedCustomer?.mobile || mobileNorm).trim();

    void (async () => {
      try {
        await sendNewAccountWhatsApp({
          to: whatsappTo,
          name: updatedCustomer?.name || customer.name || 'Member',
          cashbackLabel: '25',
        });
      } catch (waError) {
        console.error(
          '[NewAccount] WhatsApp send error:',
          waError?.message || waError,
        );
      }
    })();

    return res.status(201).json({
      success: true,
      message: 'Customer created successfully with ₹25 Joining Bonus credited to wallet.',
      customer: updatedCustomer,
    });
  } catch (error) {
    console.error('createCustomer error:', error);
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'A customer with this mobile number already exists.',
      });
    }
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to create customer.',
    });
  }
};

const CUSTOMER_LIST_PROJECTION =
  'name mobile email whatsappNumber AlternateMobile companyName gstin address city state pincode country membershipType membershipPlanId membershipPurchase priority walletAmount closingBalance cashbackBalance affiliateBalance withdrawable nonWithdrawable referralCode referredBy status createdAt updatedAt createdBy';

/** Build list filter — avoid broad case-insensitive $or scans when possible. */
const buildCustomerListQuery = searchRaw => {
  const query = {isDeleted: {$ne: true}};
  const search = String(searchRaw ?? '').trim();
  if (!search) return query;

  const digits = search.replace(/\D/g, '');
  const compact = search.replace(/[\s+\-()]/g, '');
  // Phone-ish input: use prefix on unique indexed mobile (index-friendly)
  if (digits.length >= 3 && digits === compact) {
    query.mobile = new RegExp(`^${escapeRegex(digits)}`);
    return query;
  }

  const escaped = escapeRegex(search);
  const contains = new RegExp(escaped, 'i');
  const prefix = new RegExp(`^${escaped}`, 'i');

  query.$or = [
    {name: prefix},
    {mobile: contains},
    {email: contains},
    {companyName: contains},
    {gstin: contains},
    {referralCode: prefix},
  ];
  return query;
};

const getCustomerById = async (req, res) => {
  try {
    const {id} = req.params;
    if (!id || !mongoose.Types.ObjectId.isValid(String(id))) {
      return res.status(400).json({
        success: false,
        message: 'Valid customer id is required.',
      });
    }

    const customer = await Customer.findOne({
      _id: id,
      isDeleted: {$ne: true},
    })
      .select(CUSTOMER_LIST_PROJECTION)
      .lean();

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found.',
      });
    }

    await attachMembershipExpiry([customer]);

    return res.status(200).json({
      success: true,
      message: 'Customer fetched successfully.',
      customer,
    });
  } catch (error) {
    console.error('getCustomerById error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch customer.',
    });
  }
};

const getCustomers = async (req, res) => {
  try {
    const search = String(req.query.search ?? '').trim();

    const limit = Math.min(
      Math.max(Number(req.query.limit) || 50, 1),
      5000,
    );

    const page = Math.max(1, Number(req.query.page) || 1);
    const skip = (page - 1) * limit;
    const includeTotal = String(req.query.includeTotal ?? 'true') !== 'false';

    const query = buildCustomerListQuery(search);

    const findQuery = Customer.find(query)
      .select(CUSTOMER_LIST_PROJECTION)
      .sort({createdAt: -1, _id: -1})
      .skip(skip)
      .limit(limit)
      .lean();

    // countDocuments is expensive on large collections — skip when client asks
    const countPromise = includeTotal
      ? Customer.countDocuments(query)
      : Promise.resolve(null);

    const [customers, total] = await Promise.all([findQuery, countPromise]);
    await attachMembershipExpiry(customers);

    const resolvedTotal = total == null ? null : total;
    const hasMore =
      resolvedTotal != null
        ? skip + customers.length < resolvedTotal
        : customers.length === limit;

    return res.status(200).json({
      success: true,
      message: 'Customers fetched successfully.',
      customers,
      total: resolvedTotal,
      limit,
      page,
      totalPages:
        resolvedTotal == null ? null : Math.ceil(resolvedTotal / limit),
      hasMore,
    });
  } catch (error) {
    console.error('getCustomers error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch customers.',
    });
  }
};

const editCustomer = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid customer id.'});
    }

    const existing = await Customer.findById(id);
    if (!existing) {
      return res.status(404).json({success: false, message: 'Customer not found.'});
    }

    const b = req.body;
    const update = {};

    if (b.name !== undefined) {
      if (!String(b.name).trim()) {
        return res.status(400).json({success: false, message: 'Name cannot be empty.'});
      }
      update.name = String(b.name).trim();
    }
    if (b.mobile !== undefined) {
      const m = normalizeCustomerMobile(b.mobile);
      if (!m) {
        return res.status(400).json({success: false, message: 'Invalid mobile number.'});
      }
      if (m !== String(existing.mobile || '').trim()) {
        const taken = await findCustomerByMobile(m, id);
        if (taken) {
          return res.status(409).json({
            success: false,
            exists: true,
            message: 'A customer with this mobile number already exists.',
            customer: {
              id: taken._id,
              name: taken.name,
              mobile: taken.mobile,
            },
          });
        }
      }
      update.mobile = m;
    }
    if (b.email !== undefined) update.email = String(b.email ?? '').trim();
    if (b.gstin !== undefined) update.gstin = String(b.gstin ?? '').trim();
    if (b.companyName !== undefined) {
      update.companyName = String(b.companyName ?? '').trim();
    }
    if (b.address !== undefined) update.address = String(b.address ?? '').trim();
    if (b.pincode !== undefined) update.pincode = String(b.pincode ?? '').trim();
    if (b.city !== undefined) update.city = String(b.city ?? '').trim();
    if (b.state !== undefined) update.state = String(b.state ?? '').trim();
    if (b.country !== undefined) update.country = String(b.country ?? '').trim();

    if (b.membershipType !== undefined) {
      const membership = String(b.membershipType).toLowerCase();
      if (!validMemberships.includes(membership)) {
        return res.status(400).json({success: false, message: 'Invalid membership type.'});
      }
      update.membershipType = membership;
    }

    if (b.priority !== undefined) {
      const p = Number(b.priority);
      if (Number.isNaN(p) || p < 0) {
        return res.status(400).json({success: false, message: 'Invalid priority.'});
      }
      update.priority = p;
    }

    if (b.membershipPlanId !== undefined) {
      const planId = b.membershipPlanId;
      if (planId === null || planId === '') {
        update.membershipPlanId = null;
      } else if (mongoose.Types.ObjectId.isValid(String(planId))) {
        update.membershipPlanId = planId;
      }
    }

    if (b.adharNumber !== undefined) {
      const a = String(b.adharNumber ?? '').trim();
      if (a && !/^\d{12}$/.test(a)) {
        return res.status(400).json({success: false, message: 'Invalid Aadhar number.'});
      }
      update.adharNumber = a;
    }
    if (b.dob !== undefined) {
      update.dob = b.dob ? new Date(b.dob) : null;
    }
    if (b.gender !== undefined) {
      const genderNorm = normalizeGender(b.gender);
      if (genderNorm === null) {
        return res.status(400).json({success: false, message: 'Invalid gender value.'});
      }
      update.gender = genderNorm;
    }
    if (b.whatsappNumber !== undefined) {
      update.whatsappNumber = String(b.whatsappNumber ?? '').trim();
    }
    if (b.AlternateMobile !== undefined) {
      update.AlternateMobile = String(b.AlternateMobile ?? '').trim();
    }

    if (b.IFSCcode !== undefined) update.IFSCcode = String(b.IFSCcode ?? '').trim();
    if (b.bankName !== undefined) update.bankName = String(b.bankName ?? '').trim();
    if (b.branchName !== undefined) update.branchName = String(b.branchName ?? '').trim();
    if (b.accountNumber !== undefined) {
      update.accountNumber = String(b.accountNumber ?? '').trim();
    }
    if (b.panNumber !== undefined) {
      const panNorm = String(b.panNumber ?? '').trim().toUpperCase();
      if (panNorm && !/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(panNorm)) {
        return res.status(400).json({success: false, message: 'Invalid PAN number.'});
      }
      update.panNumber = panNorm;
    }
    if (b.accountHolderName !== undefined) {
      update.accountHolderName = String(b.accountHolderName ?? '').trim();
    }
    if (b.UPIID !== undefined) update.UPIID = String(b.UPIID ?? '').trim();

    if (req.file) {
      const cloudinaryUrl = await uploadOnCloudinary(req.file.path);
      if (cloudinaryUrl) {
        update.profileImage = cloudinaryUrl;
      } else {
        update.profileImage = `/uploads/customers/${req.file.filename}`;
      }
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update.',
      });
    }

    const customer = await Customer.findByIdAndUpdate(id, {$set: update}, {new: true});

    return res.status(200).json({
      success: true,
      message: 'Customer updated successfully.',
      customer,
    });
  } catch (error) {
    console.error('editCustomer error:', error);
    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'A customer with this mobile number already exists.',
      });
    }
    return res.status(500).json({
      success: false,
      message: 'Failed to update customer.',
    });
  }
};

const deleteCustomer = async (req, res) => {
  try {
    const {id} = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid customer id.'});
    }

    const deletedCustomer = await Customer.findByIdAndDelete(id);

    if (!deletedCustomer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Customer deleted successfully',
    });
  } catch (error) {
    console.error('deleteCustomer error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete customer',
    });
  }
};

/**
 * Bulk import customers from Excel-parsed rows.
 * Expected fields per row: name, email/mail, mobile/number/phone,
 * and optional walletAmount/balance/closingBalance.
 */
const normalizeImportHeader = value =>
  String(value || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

const pickImportField = (row, aliases) => {
  const wanted = new Set(aliases.map(normalizeImportHeader));
  for (const [key, value] of Object.entries(row || {})) {
    if (value === undefined || value === null) continue;
    if (wanted.has(normalizeImportHeader(key))) return value;
  }
  return '';
};

const normalizeImportMobile = raw => {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const digits = String(Math.trunc(Math.abs(raw)));
    return digits.length > 10 ? digits.slice(-10) : digits;
  }

  const text = String(raw ?? '').trim();
  if (!text) return '';
  if (/e[+-]?\d+/i.test(text)) {
    const asNum = Number(text);
    if (Number.isFinite(asNum)) return normalizeImportMobile(asNum);
  }

  const digits = text.replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
};

const normalizeImportBalance = raw => {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(0, raw);
  }
  const text = String(raw ?? '')
    .trim()
    .replace(/[,₹\s]/g, '');
  if (!text) return 0;
  const num = Number(text);
  return Number.isFinite(num) ? Math.max(0, num) : 0;
};

const importCustomers = async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.customers) ? req.body.customers : [];
    if (!rows.length) {
      return res.status(400).json({
        success: false,
        message: 'No customers provided for import.',
      });
    }

    const createdBy = {
      m_staff_id: req.user?.userId ?? req.user?.m_staff_id ?? null,
      m_staff_name: req.user?.m_staff_name ?? req.user?.name ?? null,
      m_staff_email: req.user?.m_staff_email ?? req.user?.email ?? null,
    };

    const summary = {
      total: rows.length,
      created: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    };
    const createdCustomers = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || {};
      const rowNo = i + 2; // assuming row 1 is header in Excel

      try {
        const name = String(
          pickImportField(row, [
            'name',
            'customer name',
            'full name',
            'customer',
            'client name',
          ]) ||
            row.name ||
            '',
        ).trim();
        const emailRaw = String(
          pickImportField(row, ['email', 'mail', 'email id', 'email address']) ||
            row.email ||
            '',
        )
          .trim()
          .toLowerCase();
        // Empty email must be omitted (not null) for unique email index safety
        const email = emailRaw;
        const mobile = normalizeImportMobile(
          pickImportField(row, [
            'mobile',
            'mobile number',
            'mobile no',
            'phone number',
            'phone no',
            'phonenumber',
            'contact number',
            'whatsapp',
            'phone',
            'contact',
          ]) ||
            row.mobile ||
            '',
        );
        const openingBalance = normalizeImportBalance(
          pickImportField(row, [
            'walletAmount',
            'wallet amount',
            'balance',
            'closingBalance',
            'closing balance',
            'wallet',
            'wallet balance',
            'opening balance',
          ]) ??
            row.walletAmount ??
            0,
        );

        if (!name || !mobile) {
          summary.failed += 1;
          summary.errors.push({
            row: rowNo,
            message: 'Name and mobile are required.',
          });
          continue;
        }

        if (!/^[6-9]\d{9}$/.test(mobile)) {
          summary.failed += 1;
          summary.errors.push({
            row: rowNo,
            message: `Invalid mobile: ${mobile}`,
          });
          continue;
        }

        const exists = await Customer.findOne({
          mobile,
          isDeleted: {$ne: true},
        }).select('_id');
        if (exists) {
          summary.skipped += 1;
          summary.errors.push({
            row: rowNo,
            message: `Duplicate mobile skipped: ${mobile}`,
          });
          continue;
        }

        const genderNorm = normalizeGender(row.gender);
        if (genderNorm === null) {
          summary.failed += 1;
          summary.errors.push({
            row: rowNo,
            message: 'Invalid gender value.',
          });
          continue;
        }

        const initialWallet = openingBalance > 0 ? openingBalance : 25;
        const note =
          openingBalance > 0
            ? 'Opening balance from Excel import'
            : 'Joining Bonus';

        const payload = {
          name,
          mobile,
          membershipType: 'none',
          gender: genderNorm,
          country: 'India',
          walletAmount: initialWallet,
          closingBalance: initialWallet,
          createdBy,
        };
        if (email) payload.email = email;

        const customer = await Customer.create(payload);

        if (!customer) {
          summary.failed += 1;
          summary.errors.push({
            row: rowNo,
            message: 'Failed to create customer.',
          });
          continue;
        }

        // Never persist customerId:null — it breaks unique sparse/partial indexes
        if (customer.customerId == null) {
          await Customer.updateOne(
            {_id: customer._id},
            {$unset: {customerId: 1}},
          );
          customer.customerId = undefined;
        }

        try {
          await Wallet.create({
            customerId: customer._id,
            customerName: customer.name,
            customerPhone: customer.mobile,
            walletAmount: initialWallet,
            transactions: [
              {
                type: 'credit',
                amount: initialWallet,
                note,
                referenceType:
                  openingBalance > 0 ? 'OpeningBalance' : 'JoiningBonus',
                closingBalance: initialWallet,
                createdBy,
              },
            ],
          });
        } catch (walletError) {
          await Customer.findByIdAndDelete(customer._id).catch(() => null);
          throw walletError;
        }

        summary.created += 1;
        createdCustomers.push({
          _id: customer._id,
          name: customer.name,
          mobile: customer.mobile,
          email: customer.email || '',
          membershipType: customer.membershipType || 'none',
          walletAmount: initialWallet,
          closingBalance: initialWallet,
          createdAt: customer.createdAt,
          createdBy: customer.createdBy,
        });
      } catch (error) {
        summary.failed += 1;
        let message = error?.message || 'Failed to import row';
        if (error?.code === 11000) {
          const keys = Object.keys(error?.keyPattern || {});
          if (keys.includes('mobile') || (keys.includes('name') && keys.includes('mobile'))) {
            message = 'Duplicate mobile';
          } else if (keys.includes('email')) {
            message = 'Duplicate email';
          } else if (keys.includes('customerId')) {
            message = 'Customer id conflict (retry import)';
          } else {
            message = `Duplicate ${keys[0] || 'field'}`;
          }
        }
        summary.errors.push({
          row: rowNo,
          message,
        });
      }
    }

    return res.status(200).json({
      success: summary.created > 0,
      message: `Import finished. Created ${summary.created}, skipped ${summary.skipped}, failed ${summary.failed}.`,
      summary,
      customers: createdCustomers,
    });
  } catch (error) {
    console.error('importCustomers error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to import customers.',
    });
  }
};

export {
  createCustomer,
  getCustomers,
  getCustomerById,
  editCustomer,
  deleteCustomer,
  importCustomers,
  checkCustomerPhone,
};

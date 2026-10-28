import fs from "fs";
import path from "path";
import multer from "multer";
import {fileURLToPath} from "url";
import mongoose from "mongoose";
import Vendor from "../models/vendor.model.js";
import VendorActivity from "../models/vendorActivity.model.js";
import {vendorListStats} from "../services/vendorInsights.service.js";
import {uploadOnCloudinary} from "../utils/cloudinary.js";

const normalizeVendorGender = raw => {
  const value = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!value || value === 'not specified' || value === 'n/a' || value === 'na') {
    return '';
  }
  if (value === 'male') return 'Male';
  if (value === 'female') return 'Female';
  if (value === 'other') return 'Other';
  if (['Male', 'Female', 'Other', ''].includes(String(raw ?? '').trim())) {
    return String(raw).trim();
  }
  return '';
};

const normalizeMobile = raw => {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const digits = String(Math.trunc(Math.abs(raw)));
    return digits.length > 10 ? digits.slice(-10) : digits;
  }
  const text = String(raw ?? '').trim();
  if (!text) return '';
  if (/e[+-]?\d+/i.test(text)) {
    const asNum = Number(text);
    if (Number.isFinite(asNum)) return normalizeMobile(asNum);
  }
  const digits = text.replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
};

const asTrimmed = (raw, fallback = '') => {
  const text = String(raw ?? '').trim();
  if (!text || /^none$/i.test(text) || text === '-') return fallback;
  return text;
};

const phoneOk = value => /^[6-9]\d{9}$/.test(String(value || ""));

const contactPhoneError = contacts => {
  for (const row of contacts) {
    for (const phone of [row.mobile, row.whatsappNumber, row.alternateMobile].filter(Boolean)) {
      if (!phoneOk(phone)) {
        return "Enter a valid 10-digit phone number for each point of contact.";
      }
    }
  }
  return "";
};

const normalizeContacts = raw => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(row => ({
      name: asTrimmed(row?.name),
      mobile: normalizeMobile(row?.mobile),
      email: asTrimmed(row?.email).toLowerCase(),
      whatsappNumber: normalizeMobile(row?.whatsappNumber),
      alternateMobile: normalizeMobile(row?.alternateMobile ?? row?.AlternateMobile),
      dob: row?.dob || null,
      gender: normalizeVendorGender(row?.gender),
      department: asTrimmed(row?.department),
      designation: asTrimmed(row?.designation),
    }))
    .filter(row =>
      row.name ||
      row.mobile ||
      row.email ||
      row.whatsappNumber ||
      row.alternateMobile ||
      row.dob ||
      row.gender ||
      row.department ||
      row.designation,
    );
};

const normalizeDocuments = raw => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(row => ({
      url: asTrimmed(row?.url),
      name: asTrimmed(row?.name) || "document",
      mimeType: asTrimmed(row?.mimeType),
      size: Math.max(0, Number(row?.size) || 0),
    }))
    .filter(row => /^https:\/\//i.test(row.url))
    .slice(0, 5);
};

/** Vendor name comes from the point of contact. Phone is the business phone, or that contact's mobile. */
const resolveVendorIdentity = body => {
  const contacts = normalizeContacts(body?.pointsOfContact);
  const named = contacts.find(row => row.name);
  const personName = asTrimmed(named?.name) || asTrimmed(body?.name);
  const personPhone = normalizeMobile(named?.mobile || body?.mobile);
  const companyName = asTrimmed(body?.companyName);
  const businessPhone = normalizeMobile(body?.businessPhoneNumber);
  const mobile = businessPhone || personPhone;

  if (!personName && !companyName) {
    return { error: "Enter the vendor name in Point of Contact, or the company name." };
  }
  if (!mobile || !phoneOk(mobile)) {
    return { error: "Enter a valid 10-digit business phone number or point of contact mobile number." };
  }
  for (const phone of [personPhone, businessPhone].filter(Boolean)) {
    if (!phoneOk(phone)) {
      return { error: "Enter a valid 10-digit phone number." };
    }
  }
  return {
    values: {
      name: personName || companyName,
      mobile,
      companyName,
      businessPhoneNumber: businessPhone,
    },
    phones: [...new Set([mobile, businessPhone, personPhone].filter(Boolean))],
  };
};

const asNumber = (raw, fallback = 0) => {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const text = String(raw ?? '')
    .trim()
    .replace(/[,₹\s]/g, '');
  if (!text || /^none$/i.test(text) || text === '-') return fallback;
  const num = Number(text);
  return Number.isFinite(num) ? num : fallback;
};

/** "22-CHATTISGARH" → "CHATTISGARH" (keeps plain state names as-is) */
const normalizeState = raw => {
  const text = asTrimmed(raw);
  if (!text) return '';
  const match = text.match(/^\d+\s*[-–]\s*(.+)$/);
  return (match?.[1] || text).trim();
};

const joinAddress = (line1, line2) =>
  [asTrimmed(line1), asTrimmed(line2)].filter(Boolean).join(', ');

export const getVendors = async (req, res) => {
  try {
    const vendors = await Vendor.find().sort({ createdAt: -1 });
    const rows = await vendorListStats(vendors);
    res.status(200).json({ success: true, vendors: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getVendorById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid vendor id." });
    }
    const vendor = await Vendor.findById(id);
    if (!vendor) {
      return res.status(404).json({ success: false, message: "Vendor not found." });
    }
    return res.status(200).json({ success: true, vendor });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const createVendor = async (req, res) => {
  try {
    const {
      name,
      mobile,
      email,
      gstin,
      companyName,
      address,
      billingAddress1,
      billingAddress2,
      pincode,
      city,
      state,
      country,
      openingBalance,
      debitLimit,
      defaultDueDays,
      closingBalance,
      netBalance,
      notes,
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
      businessPhoneNumber,
      brandName,
      website,
      businessEmail,
      msme,
      udyamNumber,
      cinNumber,
      pointsOfContact,
      documents,
    } = req.body;

    const identity = resolveVendorIdentity({
      name,
      mobile,
      companyName,
      businessPhoneNumber,
      pointsOfContact,
    });
    if (identity.error) {
      return res.status(400).json({ success: false, message: identity.error });
    }
    const contacts = normalizeContacts(pointsOfContact);
    const contactError = contactPhoneError(contacts);
    if (contactError) {
      return res.status(400).json({ success: false, message: contactError });
    }
    const existingVendor = await Vendor.findOne({
      $or: [
        { mobile: { $in: identity.phones } },
        { businessPhoneNumber: { $in: identity.phones } },
      ],
    });

    if (existingVendor) {
      return res.status(409).json({
        success: false,
        message: "Vendor with this phone number already exists.",
      });
    }

    const line1 = asTrimmed(billingAddress1 ?? address);
    const line2 = asTrimmed(billingAddress2);
    const opening = asNumber(openingBalance, 0);
    const net = asNumber(netBalance, opening);
    const closing = asNumber(closingBalance, net);

    const vendor = await Vendor.create({
      ...identity.values,

      email: String(email ?? "").trim(),
      gstin: String(gstin ?? "").trim(),
      brandName: asTrimmed(brandName),
      website: asTrimmed(website),
      businessEmail: asTrimmed(businessEmail).toLowerCase(),
      msme: asTrimmed(msme),
      udyamNumber: asTrimmed(udyamNumber).toUpperCase(),
      cinNumber: asTrimmed(cinNumber).toUpperCase(),
      pointsOfContact: contacts,
      documents: normalizeDocuments(documents),

      address: joinAddress(line1, line2) || asTrimmed(address),
      billingAddress1: line1,
      billingAddress2: line2,
      pincode: asTrimmed(pincode),

      city: asTrimmed(city),
      state: normalizeState(state),
      country: asTrimmed(country, "India"),

      openingBalance: opening,
      debitLimit: asNumber(debitLimit, 0),
      defaultDueDays: asNumber(defaultDueDays, -1),
      closingBalance: closing,
      netBalance: net,
      notes: asTrimmed(notes),

      adharNumber: String(adharNumber ?? "").trim(),
      dob: dob || null,
      gender: normalizeVendorGender(gender),

      whatsappNumber: String(whatsappNumber ?? "").trim(),
      AlternateMobile: String(AlternateMobile ?? "").trim(),

      IFSCcode: String(IFSCcode ?? "").trim(),
      bankName: String(bankName ?? "").trim(),
      branchName: String(branchName ?? "").trim(),

      accountNumber: String(accountNumber ?? "").trim(),
      accountHolderName: String(accountHolderName ?? "").trim(),

      panNumber: String(panNumber ?? "").trim(),
      UPIID: String(UPIID ?? "").trim(),
    });

    return res.status(201).json({
      success: true,
      message: "Vendor created successfully.",
      vendor,
    });
  } catch (error) {
    console.error("Create Vendor Error:", error);

    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: "Duplicate entry found.",
      });
    }

    return res.status(500).json({
      success: false,
      message: error.message || "Internal Server Error",
    });
  }
};

export const importVendors = async (req, res) => {
  try {
    const rows = Array.isArray(req.body?.vendors) ? req.body.vendors : [];
    if (!rows.length) {
      return res.status(400).json({
        success: false,
        message: 'No vendors provided for import.',
      });
    }

    const summary = {
      total: rows.length,
      created: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    };
    const createdVendors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] || {};
      const rowNo = i + 2;

      try {
        const companyName = asTrimmed(row.companyName ?? row.company);
        const name = asTrimmed(row.name) || companyName;
        const email = asTrimmed(row.email ?? row.mail).toLowerCase();
        const mobile = normalizeMobile(
          row.mobile ?? row.phone ?? row.Phone ?? row.number,
        );
        const gstin = asTrimmed(row.gstin ?? row.gst).toUpperCase();
        const billingAddress1 = asTrimmed(
          row.billingAddress1 ??
            row.billing_address_1 ??
            row.address1 ??
            row.address,
        );
        const billingAddress2 = asTrimmed(
          row.billingAddress2 ?? row.billing_address_2 ?? row.address2,
        );
        const city = asTrimmed(row.city ?? row.billingCity);
        const state = normalizeState(row.state ?? row.billingState);
        const pincode = asTrimmed(row.pincode ?? row.billingPincode);
        const country = asTrimmed(
          row.country ?? row.billingCountry,
          'India',
        );
        const openingBalance = asNumber(
          row.openingBalance ?? row.OpeningBalance,
          0,
        );
        const debitLimit = asNumber(row.debitLimit ?? row.DebitLimit, 0);
        const defaultDueDays = asNumber(
          row.defaultDueDays ?? row.defaultDueDate ?? row.DefaultDueDate,
          -1,
        );
        const netBalance = asNumber(
          row.netBalance ?? row.NetBalance,
          openingBalance,
        );
        const closingBalance = asNumber(
          row.closingBalance ?? row.netBalance ?? row.NetBalance,
          netBalance,
        );
        const notes = asTrimmed(row.notes ?? row.Notes);

        if (!mobile) {
          summary.failed += 1;
          summary.errors.push({
            row: rowNo,
            message: 'Phone/mobile is required.',
          });
          continue;
        }

        if (!name) {
          summary.failed += 1;
          summary.errors.push({
            row: rowNo,
            message: 'Name or Company is required.',
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

        const exists = await Vendor.findOne({mobile}).select('_id');
        if (exists) {
          summary.skipped += 1;
          summary.errors.push({
            row: rowNo,
            message: `Duplicate mobile skipped: ${mobile}`,
          });
          continue;
        }

        const vendor = await Vendor.create({
          name,
          mobile,
          email,
          companyName: companyName || name,
          gstin,
          billingAddress1,
          billingAddress2,
          address: joinAddress(billingAddress1, billingAddress2),
          city,
          state,
          pincode,
          country,
          openingBalance,
          debitLimit,
          defaultDueDays,
          closingBalance,
          netBalance,
          notes,
          gender: '',
        });

        summary.created += 1;
        createdVendors.push(vendor);
      } catch (error) {
        summary.failed += 1;
        summary.errors.push({
          row: rowNo,
          message:
            error?.code === 11000
              ? 'Duplicate mobile'
              : error?.message || 'Failed to import row',
        });
      }
    }

    return res.status(200).json({
      success: summary.created > 0,
      message: `Import finished. Created ${summary.created}, skipped ${summary.skipped}, failed ${summary.failed}.`,
      summary,
      vendors: createdVendors,
    });
  } catch (error) {
    console.error('importVendors error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to import vendors.',
    });
  }
};

export const updateVendor = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid vendor id." });
    }
    const existing = await Vendor.findById(id).lean();
    if (!existing) {
      return res.status(404).json({ success: false, message: "Vendor not found." });
    }
    const identity = resolveVendorIdentity({
      name: req.body?.name ?? existing.name,
      mobile: req.body?.mobile ?? existing.mobile,
      companyName: req.body?.companyName ?? existing.companyName,
      businessPhoneNumber: req.body?.businessPhoneNumber ?? existing.businessPhoneNumber,
      pointsOfContact: req.body?.pointsOfContact ?? existing.pointsOfContact,
    });
    if (identity.error) {
      return res.status(400).json({ success: false, message: identity.error });
    }
    const duplicate = await Vendor.findOne({
      _id: { $ne: existing._id },
      $or: [
        { mobile: { $in: identity.phones } },
        { businessPhoneNumber: { $in: identity.phones } },
      ],
    }).select("_id");
    if (duplicate) {
      return res.status(409).json({
        success: false,
        message: "Vendor with this phone number already exists.",
      });
    }
    if (Array.isArray(req.body?.pointsOfContact)) {
      const contactError = contactPhoneError(normalizeContacts(req.body.pointsOfContact));
      if (contactError) {
        return res.status(400).json({ success: false, message: contactError });
      }
    }
    const nextBody = { ...req.body, ...identity.values };
    if (req.body?.msme !== undefined) nextBody.msme = asTrimmed(req.body.msme);
    if (req.body?.udyamNumber !== undefined) {
      nextBody.udyamNumber = asTrimmed(req.body.udyamNumber).toUpperCase();
    }
    if (req.body?.cinNumber !== undefined) {
      nextBody.cinNumber = asTrimmed(req.body.cinNumber).toUpperCase();
    }
    if (Array.isArray(req.body?.pointsOfContact)) {
      nextBody.pointsOfContact = normalizeContacts(req.body.pointsOfContact);
    }
    if (Array.isArray(req.body?.documents)) {
      nextBody.documents = normalizeDocuments(req.body.documents);
    }
    delete nextBody._id;
    const vendor = await Vendor.findByIdAndUpdate(id, { $set: nextBody }, { new: true });
    const bankFields = ["bankName", "branchName", "accountHolderName", "accountNumber", "IFSCcode", "UPIID"];
    const bankChanged = bankFields.some(field => {
      if (req.body?.[field] === undefined) return false;
      return String(req.body[field] ?? "").trim() !== String(existing[field] ?? "").trim();
    });
    if (bankChanged) {
      const account = String(req.body.accountNumber ?? existing.accountNumber ?? "").replace(/\D/g, "");
      const masked = account.length >= 4 ? `ending ${account.slice(-4)}` : "details updated";
      await VendorActivity.create({
        vendorId: existing._id,
        type: "bank",
        title: "Bank account updated",
        detail: `Bank details changed (${masked}).`,
        at: new Date(),
        by: {
          m_staff_id: req.staff?.m_staff_id || null,
          m_staff_name: req.staff?.fullName || req.user?.name || null,
          m_staff_email: req.staff?.email || req.user?.email || null,
        },
      });
    }
    return res.status(200).json({ success: true, vendor });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

const localUploadsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../uploads/vendor-documents");
const tmpUploadsDir = path.join("/tmp", "uploads", "vendor-documents");
let vendorUploadRoot = localUploadsDir;
try {
  fs.mkdirSync(localUploadsDir, {recursive: true});
} catch {
  fs.mkdirSync(tmpUploadsDir, {recursive: true});
  vendorUploadRoot = tmpUploadsDir;
}

export const vendorDocumentUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, vendorUploadRoot),
    filename: (_req, file, callback) => {
      const safe = String(file.originalname || "document").replace(/[^\w.\-]+/g, "_").slice(0, 80);
      callback(null, `${Date.now()}-${safe}`);
    },
  }),
  limits: {fileSize: 5 * 1024 * 1024},
  fileFilter: (_req, file, callback) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    if (!allowed.includes(file.mimetype)) {
      callback(new Error("Upload a JPG, PNG, WEBP, or PDF up to 5 MB."));
      return;
    }
    callback(null, true);
  },
}).single("file");

export const uploadVendorDocument = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({success: false, message: "Choose a file to upload."});
    }
    const url = await uploadOnCloudinary(req.file.path, {folder: "vendor-documents"});
    if (!url) {
      return res.status(502).json({
        success: false,
        message: "The document could not be stored. Check cloud storage and try again.",
      });
    }
    return res.status(201).json({
      success: true,
      document: {
        url,
        name: req.file.originalname || "document",
        mimeType: req.file.mimetype,
        size: req.file.size,
      },
    });
  } catch (error) {
    console.error("uploadVendorDocument error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Could not upload the document.",
    });
  }
};

export const deleteVendor = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid vendor id." });
    }
    const vendor = await Vendor.findByIdAndDelete(id);
    if (!vendor) {
      return res.status(404).json({ success: false, message: "Vendor not found." });
    }
    return res.status(200).json({ success: true, message: "Vendor deleted successfully." });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
 
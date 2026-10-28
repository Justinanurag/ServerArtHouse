import mongoose from 'mongoose';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Lead from '../models/lead.model.js';
import Customer from '../models/customer.model.js';
import Membership from '../models/membership.model.js';
import User from '../models/auth.model.js';
import Counter from '../models/counter.model.js';
import { uploadOnCloudinary } from '../utils/cloudinary.js';
import { attachMembershipExpiry } from '../services/membershipEligibility.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const localUploadsDir = path.resolve(__dirname, '../../uploads/leads');
const tmpUploadsDir = path.join('/tmp', 'uploads', 'leads');

let uploadsDir = localUploadsDir;
try {
  fs.mkdirSync(localUploadsDir, { recursive: true });
} catch (error) {
  fs.mkdirSync(tmpUploadsDir, { recursive: true });
  uploadsDir = tmpUploadsDir;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const uniqueName = `${Date.now()}-${file.originalname.replace(/\s+/g, '')}`;
    cb(null, uniqueName);
  },
});

export const uploadLeadAttachments = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max per file
});

const uploadLeadFiles = async (files) => {
  if (!files || !files.length) return [];
  const uploaded = [];
  for (const file of files) {
    try {
      const cloudinaryUrl = await uploadOnCloudinary(file.path, {
        folder: 'woowoo/leads',
      });
      uploaded.push({
        url: cloudinaryUrl || `/uploads/leads/${file.filename}`,
        name: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
      });
    } catch (err) {
      console.error('Lead attachment upload error:', err);
      uploaded.push({
        url: `/uploads/leads/${file.filename}`,
        name: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
      });
    }
  }
  return uploaded;
};

const normalizeAttachments = (items) => {
  if (!items) return [];
  if (typeof items === 'string') {
    try {
      items = JSON.parse(items);
    } catch {
      items = [items];
    }
  }
  if (!Array.isArray(items)) items = [items];
  return items
    .map((item) => {
      if (!item) return null;
      if (typeof item === 'string') {
        const parts = item.split('/');
        return {
          url: item,
          name: parts[parts.length - 1] || 'attachment',
          mimeType: '',
          size: 0,
        };
      }
      if (typeof item === 'object' && item.url) {
        return {
          url: item.url,
          name: item.name || item.url.split('/').pop() || 'attachment',
          mimeType: item.mimeType || '',
          size: Number(item.size) || 0,
        };
      }
      return null;
    })
    .filter(Boolean);
};

const parseMaybeJson = (value) => {
  if (value == null || value === '') return undefined;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const NO_MEMBERSHIP = new Set(['', 'none', 'null', 'undefined']);

/**
 * Leads may repeat a number; when a customer with that mobile holds a membership,
 * return { phone -> { label, planId, customerId, customerName } }.
 */
const getMembershipsByPhone = async (phones) => {
  const unique = [...new Set(phones.map((p) => String(p || '').trim()).filter((p) => /^\d{10}$/.test(p)))];
  if (!unique.length) return new Map();

  const customers = await Customer.find({ mobile: { $in: unique }, isDeleted: { $ne: true } })
    .select('_id name mobile membershipType membershipPlanId membershipPurchase')
    .lean();
  const members = customers.filter(
    (c) => !NO_MEMBERSHIP.has(String(c.membershipType ?? '').trim().toLowerCase()),
  );
  if (!members.length) return new Map();
  await attachMembershipExpiry(members);
  const activeMembers = members.filter((c) => !c.membershipExpired);
  if (!activeMembers.length) return new Map();

  const planIds = [...new Set(activeMembers.map((c) => String(c.membershipType).trim().toLowerCase()))];
  const planObjectIds = activeMembers.map((c) => c.membershipPlanId).filter(Boolean);
  const plans = await Membership.find({
    $or: [{ planId: { $in: planIds } }, { _id: { $in: planObjectIds } }],
  })
    .select('_id planId displayName')
    .lean();
  const byObjectId = new Map(plans.map((p) => [String(p._id), p]));
  const byPlanId = new Map(plans.map((p) => [String(p.planId).toLowerCase(), p]));

  const result = new Map();
  for (const c of activeMembers) {
    const key = String(c.membershipType).trim().toLowerCase();
    const plan = (c.membershipPlanId && byObjectId.get(String(c.membershipPlanId))) || byPlanId.get(key);
    result.set(c.mobile, {
      label: plan?.displayName || key.charAt(0).toUpperCase() + key.slice(1),
      planId: plan?.planId || key,
      customerId: c._id,
      customerName: c.name,
    });
  }
  return result;
};

const LEAD_STATUSES = new Set([
  'New',
  'Contacted',
  'Interested',
  'Contact Tomorrow',
  'Contact in 2 Days',
  'Come for Visit',
  'Shared Quotation',
  'Negotiation',
  'Follow Up (Custom)',
  'Not Interested',
  'Need to message',
  'Converted',
  'Lost',
]);

const actorFromRequest = async (req) => {
  const userId = req.user?.userId ? String(req.user.userId) : null;
  if (userId && mongoose.Types.ObjectId.isValid(userId)) {
    const user = await User.findById(userId).select('fullName email m_staff_id').lean();
    if (user) {
      return {
        m_staff_id: user.m_staff_id || userId,
        m_staff_name: user.fullName || null,
        m_staff_email: user.email || null,
      };
    }
  }
  return { m_staff_id: userId, m_staff_name: null, m_staff_email: null };
};

const pushCreatedEvent = (lead, actor) => {
  if (Array.isArray(lead.timeline) && lead.timeline.length) return;
  lead.timeline = lead.timeline || [];
  lead.timeline.push({
    type: 'created',
    title: 'Lead Created',
    status: 'New',
    note: lead.source ? `Lead from ${lead.source}` : '',
    at: lead.createdAt || lead.date || new Date(),
    by: lead.createdBy?.m_staff_name ? lead.createdBy : actor,
  });
};

export const LEAD_PREFIX = 'LEAD';

export const getNextLeadNumber = async () => {
  const counter = await Counter.findOneAndUpdate(
    { key: 'lead_number' },
    { $inc: { value: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return counter.value;
};

export const generateUniqueLeadId = async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const nextSeq = await getNextLeadNumber();
    const leadNumber = nextSeq < 1000 ? 1000 + nextSeq : nextSeq;
    const leadId = `${LEAD_PREFIX}-${leadNumber}`;
    const exists = await Lead.exists({ leadId });
    if (!exists) {
      return { leadId, leadNumber, leadPrefix: LEAD_PREFIX };
    }
  }
  const fallbackNum = Date.now();
  return {
    leadId: `${LEAD_PREFIX}-${fallbackNum}`,
    leadNumber: fallbackNum,
    leadPrefix: LEAD_PREFIX,
  };
};

let backfillPromise = null;

export const backfillExistingLeads = async () => {
  if (backfillPromise) return backfillPromise;
  backfillPromise = (async () => {
    try {
      const unassignedLeads = await Lead.find({
        $or: [
          { leadId: { $exists: false } },
          { leadId: null },
          { leadId: '' },
          { leadNumber: { $exists: false } },
          { leadNumber: null },
        ],
      }).sort({ createdAt: 1 });

      if (!unassignedLeads.length) {
        const c = await Counter.findOne({ key: 'lead_number' });
        if (!c) {
          await Counter.create({ key: 'lead_number', value: 1000 });
        }
        return;
      }

      let counterDoc = await Counter.findOne({ key: 'lead_number' });
      let currentVal = counterDoc ? Math.max(counterDoc.value, 1000) : 1000;

      for (const lead of unassignedLeads) {
        currentVal += 1;
        const leadId = `${LEAD_PREFIX}-${currentVal}`;
        await Lead.updateOne(
          { _id: lead._id },
          {
            $set: {
              leadId,
              leadNumber: currentVal,
              leadPrefix: LEAD_PREFIX,
            },
          }
        );
      }

      await Counter.findOneAndUpdate(
        { key: 'lead_number' },
        { $set: { value: currentVal } },
        { upsert: true }
      );
      console.log(`✅ Backfilled ${unassignedLeads.length} leads with unique IDs up to ${LEAD_PREFIX}-${currentVal}`);
    } catch (err) {
      console.error('Error during backfillExistingLeads:', err);
    }
  })();
  return backfillPromise;
};

const withMembership = (lead, memberships) => {
  const obj = typeof lead?.toObject === 'function' ? lead.toObject() : lead;
  return {
    ...obj,
    leadId: obj.leadId || (obj._id ? `${LEAD_PREFIX}-${obj._id.toString().slice(-6).toUpperCase()}` : ''),
    membership: memberships.get(String(obj?.phone || '').trim()) || null,
  };
};

export const getLeadMembership = async (req, res) => {
  try {
    const phone = String(req.query.phone || '').replace(/\D/g, '').slice(-10);
    if (!/^\d{10}$/.test(phone)) {
      return res.status(400).json({ success: false, message: 'Valid 10-digit phone is required' });
    }
    const memberships = await getMembershipsByPhone([phone]);
    res.status(200).json({ success: true, data: memberships.get(phone) || null });
  } catch (error) {
    console.error('Get Lead Membership Error:', error);
    res.status(500).json({ success: false, message: 'Failed to check membership', error: error.message });
  }
};

export const getLead = async (req, res) => {
  try {
    await backfillExistingLeads();
    const { fromDate, toDate, purpose, status, source, assignedTo, deadline, deadlineFrom, deadlineTo, search, leadId } = req.query;
    const filter = {};

    if (leadId && leadId.trim()) {
      filter.leadId = new RegExp(leadId.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }

    if (search && search.trim()) {
      const s = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rx = new RegExp(s, 'i');
      filter.$or = [
        { leadId: rx },
        { name: rx },
        { phone: rx },
      ];
    }

    if (purpose && purpose !== 'all') {
      filter.purpose = purpose.trim();
    }
    if (status && status !== 'all') {
      filter.status = status.trim();
    }
    if (source && source !== 'all') {
      filter.source = source.trim();
    }
    if (assignedTo && assignedTo !== 'all') {
      if (assignedTo === 'unassigned') {
        filter.$or = [
          { 'assignedTo.m_staff_name': null },
          { 'assignedTo.m_staff_name': '' },
          { assignedTo: { $exists: false } },
          { assignedTo: null },
        ];
      } else if (assignedTo === 'assigned') {
        filter.$or = [
          { 'assignedTo.m_staff_name': { $exists: true, $nin: [null, ''] } },
          { 'assignedTo.m_staff_id': { $exists: true, $nin: [null, ''] } },
        ];
      } else {
        const rx = new RegExp(`^${assignedTo.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
        filter.$or = [
          { 'assignedTo.m_staff_name': rx },
          { 'assignedTo.m_staff_id': assignedTo.trim() },
        ];
      }
    }

    if (deadline && deadline !== 'all') {
      const d = new Date(deadline);
      if (!isNaN(d.getTime())) {
        const start = new Date(d);
        start.setUTCHours(0, 0, 0, 0);
        const end = new Date(d);
        end.setUTCHours(23, 59, 59, 999);
        filter.deadline = { $gte: start, $lte: end };
      }
    } else if (deadlineFrom || deadlineTo) {
      filter.deadline = {};
      if (deadlineFrom) {
        const start = new Date(`${deadlineFrom}T00:00:00.000Z`);
        if (!isNaN(start.getTime())) {
          filter.deadline.$gte = start;
        }
      }
      if (deadlineTo) {
        const end = new Date(`${deadlineTo}T23:59:59.999Z`);
        if (!isNaN(end.getTime())) {
          filter.deadline.$lte = end;
        }
      }
    }

    //fromdate

       if (fromDate || toDate) {
      filter.createdAt = {};

      // From date
      if (fromDate) {
        const startDate = new Date(`${fromDate}T00:00:00.000Z`);

        if (isNaN(startDate.getTime())) {
          return res.status(400).json({
            success: false,
            message: "Invalid fromDate",
          });
        }

        filter.createdAt.$gte = startDate;
      }

      // To date
      if (toDate) {
        const endDate = new Date(`${toDate}T23:59:59.999Z`);

        if (isNaN(endDate.getTime())) {
          return res.status(400).json({
            success: false,
            message: "Invalid toDate",
          });
        }

        filter.createdAt.$lte = endDate;
      }
    }
    const leads = await Lead.find(filter).sort({ createdAt: -1 }).lean();
    console.log(leads);
    const memberships = await getMembershipsByPhone(leads.map((l) => l.phone));

    res.status(200).json({
      success: true,
      message: "Leads fetched successfully",
      data: leads.map((lead) => withMembership(lead, memberships)),
    });
  } catch (error) {
    console.error("Get Leads Error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch leads",
      error: error.message,
    });
  }
};
//Get By Id
export const getLeadById = async (req, res) => {
  try {
    const { id } = req.params;
    let lead = null;

    if (id && mongoose.Types.ObjectId.isValid(id)) {
      lead = await Lead.findById(id);
    }
    if (!lead && id) {
      lead = await Lead.findOne({
        $or: [
          { leadId: String(id).trim().toUpperCase() },
          { leadId: String(id).trim() },
        ],
      });
    }

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    const memberships = await getMembershipsByPhone([lead.phone]);

    res.status(200).json({
      success: true,
      message: "Lead fetched successfully",
      data: withMembership(lead, memberships),
    });
  } catch (error) {
    console.error("Get Lead By ID Error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to fetch lead",
      error: error.message,
    });
  }
};
// Patch
export const updateLead = async (req, res) => {
  try {
    const id = req.params.id || req.body.id || req.body._id;
    let lead = null;

    if (id && mongoose.Types.ObjectId.isValid(id)) {
      lead = await Lead.findById(id);
    }
    if (!lead && id) {
      lead = await Lead.findOne({
        $or: [
          { leadId: String(id).trim().toUpperCase() },
          { leadId: String(id).trim() },
        ],
      });
    }

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    if (!lead.leadId) {
      const generated = await generateUniqueLeadId();
      lead.leadId = generated.leadId;
      lead.leadNumber = generated.leadNumber;
      lead.leadPrefix = generated.leadPrefix;
    }

    if (req.body.name !== undefined) {
      lead.name = req.body.name;
    }

    if (req.body.phone !== undefined) {
      lead.phone = req.body.phone;
    }

    const previousStatus = lead.status;
    if (req.body.status !== undefined) {
      lead.status = req.body.status;
    }

    if (req.body.source !== undefined) {
      lead.source = req.body.source;
    }

    if (req.body.purpose !== undefined) {
      lead.purpose = req.body.purpose;
    }

    if (req.body.deadline !== undefined) {
      if (req.body.deadline && typeof req.body.deadline === 'string' && req.body.deadline.trim()) {
        const d = new Date(req.body.deadline);
        lead.deadline = !isNaN(d.getTime()) ? d : null;
      } else if (req.body.deadline instanceof Date && !isNaN(req.body.deadline.getTime())) {
        lead.deadline = req.body.deadline;
      } else {
        lead.deadline = null;
      }
    }

    if (req.body.reasonNote !== undefined) {
      lead.reasonNote = req.body.reasonNote;
    }

    if (req.body.url !== undefined) {
      lead.url = req.body.url != null ? String(req.body.url).trim() : "";
    }

    if (req.body.assignedTo !== undefined) {
      lead.assignedTo = parseMaybeJson(req.body.assignedTo);
    }

    if (req.body.createdBy !== undefined) {
      lead.createdBy = parseMaybeJson(req.body.createdBy);
    }

    // Handle attachments (existing + newly uploaded)
    if (req.body.attachments !== undefined || (req.files && req.files.length > 0)) {
      const existingAttachments = req.body.attachments !== undefined
        ? normalizeAttachments(req.body.attachments)
        : (lead.attachments || []);
      const newAttachments = await uploadLeadFiles(req.files);
      lead.attachments = [...existingAttachments, ...newAttachments];
    }

    if (req.body.status !== undefined && req.body.status !== previousStatus) {
      const actor = await actorFromRequest(req);
      pushCreatedEvent(lead, actor);
      lead.timeline.push({
        type: 'status',
        title: req.body.status === 'Converted' ? 'Converted' : 'Status Updated',
        status: req.body.status,
        note: '',
        at: new Date(),
        by: actor,
      });
    }

    const updatedLead = await lead.save();
    const memberships = await getMembershipsByPhone([updatedLead.phone]);

    res.status(200).json({
      success: true,
      message: "Lead updated successfully",
      data: withMembership(updatedLead, memberships),
    });
  } catch (error) {
    console.error("Update Lead Error:", error);

    // Mongoose validation error
    if (error.name === "ValidationError") {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: Object.values(error.errors).map(
          (err) => err.message
        ),
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to update lead",
      error: error.message,
    });
  }
};
//Post

export const createLead = async (req, res) => {
  try {
    const {
      name,
      phone,
      status,
      source,
      purpose,
      deadline,
      reasonNote,
      url,
      createdBy,
      assignedTo,
      attachments,
    } = req.body;

    // Name validation
    if (!name || !name.trim()) {
      return res.status(400).json({
        success: false,
        message: "Name is required",
      });
    }

    // Phone validation
    const phoneTrimmed = phone?.trim() || "";
    if (!phoneTrimmed) {
      return res.status(400).json({
        success: false,
        message: "Phone number is required",
      });
    }

    if (!/^\d{10}$/.test(phoneTrimmed)) {
      return res.status(400).json({
        success: false,
        message: "Phone number must be a valid 10-digit number",
      });
    }

    let parsedDeadline = null;
    if (deadline && typeof deadline === 'string' && deadline.trim()) {
      const d = new Date(deadline);
      if (!isNaN(d.getTime())) {
        parsedDeadline = d;
      }
    } else if (deadline instanceof Date && !isNaN(deadline.getTime())) {
      parsedDeadline = deadline;
    }

    const createdByParsed = parseMaybeJson(createdBy);
    const assignedToParsed = parseMaybeJson(assignedTo);

    const existingAttachments = normalizeAttachments(attachments);
    const newAttachments = await uploadLeadFiles(req.files);
    const allAttachments = [...existingAttachments, ...newAttachments];

    const actor = await actorFromRequest(req);
    const initialStatus = status || "New";
    const { leadId, leadNumber, leadPrefix } = await generateUniqueLeadId();
    const lead = await Lead.create({
      leadId,
      leadNumber,
      name: name.trim(),
      phone: phoneTrimmed,
      status: initialStatus,
      source: source?.trim() || "",
      purpose: purpose?.trim() || "",
      deadline: parsedDeadline,
      reasonNote: reasonNote?.trim() || "",
      url: url?.trim() || "",
      attachments: allAttachments,
      createdBy: createdByParsed || actor,
      assignedTo: assignedToParsed || undefined,
      timeline: [
        {
          type: 'created',
          title: 'Lead Created',
          status: 'New',
          note: source?.trim() ? `Lead from ${source.trim()}` : '',
          at: new Date(),
          by: createdByParsed?.m_staff_name ? createdByParsed : actor,
        },
        ...(initialStatus !== 'New'
          ? [
              {
                type: 'status',
                title: initialStatus === 'Converted' ? 'Converted' : 'Status Updated',
                status: initialStatus,
                note: '',
                at: new Date(),
                by: createdByParsed?.m_staff_name ? createdByParsed : actor,
              },
            ]
          : []),
      ],
    });

    const memberships = await getMembershipsByPhone([lead.phone]);

    res.status(201).json({
      success: true,
      message: "Lead created successfully",
      data: withMembership(lead, memberships),
    });
  } catch (error) {
    console.error("Create Lead Error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to create lead",
      error: error.message,
    });
  }
};
//Delete

export const addLeadTimeline = async (req, res) => {
  try {
    const id = req.params.id;
    let lead = null;
    if (id && mongoose.Types.ObjectId.isValid(id)) {
      lead = await Lead.findById(id);
    }
    if (!lead && id) {
      lead = await Lead.findOne({
        $or: [
          { leadId: String(id).trim().toUpperCase() },
          { leadId: String(id).trim() },
        ],
      });
    }
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    const status = String(req.body.status || '').trim();
    if (!LEAD_STATUSES.has(status)) {
      return res.status(400).json({ success: false, message: 'Choose a valid lead status.' });
    }

    let followUpAt = null;
    if (req.body.followUpAt) {
      const parsed = new Date(req.body.followUpAt);
      if (!Number.isNaN(parsed.getTime())) followUpAt = parsed;
    }
    const reminderTime = String(req.body.reminderTime || '').trim();
    const note = String(req.body.note || '').trim();
    const actor = await actorFromRequest(req);
    pushCreatedEvent(lead, actor);
    lead.status = status;
    lead.timeline.push({
      type: 'status',
      title: status === 'Converted' ? 'Converted' : 'Status Updated',
      status,
      note,
      followUpAt,
      reminderTime,
      at: new Date(),
      by: actor,
    });
    const saved = await lead.save();
    const memberships = await getMembershipsByPhone([saved.phone]);
    return res.status(200).json({
      success: true,
      message: 'Lead status updated.',
      data: withMembership(saved, memberships),
    });
  } catch (error) {
    console.error('Add Lead Timeline Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update lead status',
      error: error.message,
    });
  }
};

export const deleteLead = async (req, res) => {
  try {
    const id = req.params.id || req.body.id || req.body._id;
    let deletedLead = null;

    if (id && mongoose.Types.ObjectId.isValid(id)) {
      deletedLead = await Lead.findByIdAndDelete(id);
    }
    if (!deletedLead && id) {
      deletedLead = await Lead.findOneAndDelete({
        $or: [
          { leadId: String(id).trim().toUpperCase() },
          { leadId: String(id).trim() },
        ],
      });
    }

    if (!deletedLead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Lead deleted successfully",
      data: deletedLead,
    });
  } catch (error) {
    console.error("Delete Lead Error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to delete lead",
      error: error.message,
    });
  }
};
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import mongoose from 'mongoose';
import multer from 'multer';
import CvpApplication from '../models/cvpApplication.model.js';
import {uploadOnCloudinary} from '../utils/cloudinary.js';

const SLOTS = ['Morning', 'Afternoon', 'Evening', 'Night', 'Anytime'];
const TYPES = ['Paid', 'Unpaid', 'Both'];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const localUploadsDir = path.resolve(__dirname, '../../uploads/cvp');
const tmpUploadsDir = path.join('/tmp', 'uploads', 'cvp');

let uploadsDir = localUploadsDir;
try {
  fs.mkdirSync(localUploadsDir, {recursive: true});
} catch {
  fs.mkdirSync(tmpUploadsDir, {recursive: true});
  uploadsDir = tmpUploadsDir;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const safe = String(file.originalname || 'selfie').replace(/[^\w.-]+/g, '');
    cb(null, `${Date.now()}-${safe || 'selfie'}`);
  },
});

export const uploadCvpPhoto = multer({
  storage,
  limits: {fileSize: 5 * 1024 * 1024},
  fileFilter: (_req, file, cb) => {
    cb(null, /^image\/(jpeg|jpg|png|webp)$/i.test(file.mimetype));
  },
});

const toDto = doc => {
  const plain = doc?.toObject ? doc.toObject() : doc;
  return {
    _id: plain._id,
    fullName: plain.fullName || '',
    phone: plain.phone || '',
    profession: plain.profession || '',
    photoUrl: plain.photoUrl || '',
    availability: Array.isArray(plain.availability) ? plain.availability : [],
    volunteeredBefore: Boolean(plain.volunteeredBefore),
    events: plain.events == null || plain.events === 0 ? '' : String(plain.events),
    volunteerType: plain.volunteerType || '',
    createdAt: plain.createdAt || null,
    updatedAt: plain.updatedAt || null,
  };
};

const asList = value => {
  if (Array.isArray(value)) return value;
  const text = String(value || '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return text.split(',').map(item => item.trim()).filter(Boolean);
};

const readFields = (body, {partial = false} = {}) => {
  const fullName = body?.fullName === undefined && partial
    ? undefined
    : String(body?.fullName || '').trim();
  const phone = body?.phone === undefined && partial
    ? undefined
    : String(body?.phone || '').replace(/\D/g, '').slice(-10);
  const profession = body?.profession === undefined && partial
    ? undefined
    : String(body?.profession || '').trim();
  const availability = body?.availability === undefined && partial
    ? undefined
    : [...new Set(asList(body?.availability))];
  const volunteeredRaw = body?.volunteeredBefore;
  const volunteeredBefore = volunteeredRaw === undefined && partial
    ? undefined
    : volunteeredRaw === true || String(volunteeredRaw).toLowerCase() === 'yes' || String(volunteeredRaw) === 'true';

  if (fullName !== undefined && (fullName.length < 2 || fullName.length > 120)) {
    return {error: 'Full name is required.'};
  }
  if (phone !== undefined && !/^\d{10}$/.test(phone)) {
    return {error: 'Enter a 10-digit phone number.'};
  }
  if (profession !== undefined && (profession.length < 2 || profession.length > 80)) {
    return {error: 'Profession is required.'};
  }
  if (availability !== undefined) {
    if (!availability.length || availability.some(slot => !SLOTS.includes(slot))) {
      return {error: 'Select at least one available time.'};
    }
  }

  const experienced = volunteeredBefore === true;
  let events;
  let volunteerType;
  if (volunteeredBefore !== undefined || body?.events !== undefined || body?.volunteerType !== undefined) {
    const eventText = String(body?.events ?? '').trim();
    if (experienced) {
      if (!eventText || eventText.length > 200) {
        return {error: 'Enter the events you volunteered in.'};
      }
      const type = String(body?.volunteerType || '').trim();
      if (!TYPES.includes(type)) return {error: 'Choose paid, unpaid, or both.'};
      events = eventText;
      volunteerType = type;
    } else if (volunteeredBefore === false) {
      events = '';
      volunteerType = '';
    }
  }

  return {
    value: {
      ...(fullName !== undefined ? {fullName} : {}),
      ...(phone !== undefined ? {phone} : {}),
      ...(profession !== undefined ? {profession} : {}),
      ...(availability !== undefined ? {availability} : {}),
      ...(volunteeredBefore !== undefined ? {volunteeredBefore} : {}),
      ...(events !== undefined ? {events} : {}),
      ...(volunteerType !== undefined ? {volunteerType} : {}),
    },
  };
};

const storePhoto = async file => {
  if (!file?.path) return '';
  const uploaded = await uploadOnCloudinary(file.path, {folder: 'woowoo/cvp'});
  if (uploaded) return uploaded;
  return `/uploads/cvp/${path.basename(file.path)}`;
};

export const listCvpApplications = async (_req, res) => {
  try {
    const rows = await CvpApplication.find().sort({createdAt: -1}).lean();
    return res.status(200).json({
      success: true,
      message: 'Volunteer applications fetched.',
      applications: rows.map(toDto),
    });
  } catch (error) {
    console.error('listCvpApplications error:', error);
    return res.status(500).json({success: false, message: 'Failed to fetch volunteer applications.'});
  }
};

export const getCvpApplication = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({success: false, message: 'Invalid application id.'});
    }
    const row = await CvpApplication.findById(req.params.id).lean();
    if (!row) return res.status(404).json({success: false, message: 'Volunteer application not found.'});
    return res.status(200).json({success: true, application: toDto(row)});
  } catch (error) {
    console.error('getCvpApplication error:', error);
    return res.status(500).json({success: false, message: 'Failed to fetch volunteer application.'});
  }
};

export const createCvpApplication = async (req, res) => {
  try {
    const parsed = readFields(req.body || {});
    if (parsed.error) return res.status(400).json({success: false, message: parsed.error});
    const photoUrl = await storePhoto(req.file);
    if (!photoUrl) return res.status(400).json({success: false, message: 'Add a selfie before submitting.'});
    const created = await CvpApplication.create({...parsed.value, photoUrl});
    return res.status(201).json({
      success: true,
      message: 'Volunteer application submitted.',
      application: toDto(created),
    });
  } catch (error) {
    console.error('createCvpApplication error:', error);
    return res.status(500).json({success: false, message: 'Failed to submit volunteer application.'});
  }
};

export const updateCvpApplication = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({success: false, message: 'Invalid application id.'});
    }
    const row = await CvpApplication.findById(req.params.id);
    if (!row) return res.status(404).json({success: false, message: 'Volunteer application not found.'});
    const parsed = readFields(req.body || {}, {partial: true});
    if (parsed.error) return res.status(400).json({success: false, message: parsed.error});
    Object.assign(row, parsed.value);
    if (req.file) {
      const photoUrl = await storePhoto(req.file);
      if (photoUrl) row.photoUrl = photoUrl;
    }
    await row.save();
    return res.status(200).json({
      success: true,
      message: 'Volunteer application updated.',
      application: toDto(row),
    });
  } catch (error) {
    console.error('updateCvpApplication error:', error);
    return res.status(500).json({success: false, message: 'Failed to update volunteer application.'});
  }
};

export const deleteCvpApplication = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({success: false, message: 'Invalid application id.'});
    }
    const deleted = await CvpApplication.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({success: false, message: 'Volunteer application not found.'});
    return res.status(200).json({success: true, message: 'Volunteer application deleted.'});
  } catch (error) {
    console.error('deleteCvpApplication error:', error);
    return res.status(500).json({success: false, message: 'Failed to delete volunteer application.'});
  }
};

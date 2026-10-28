import mongoose from 'mongoose';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import Food from '../models/food.model.js';
import {uploadOnCloudinary} from '../utils/cloudinary.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const localUploadsDir = path.resolve(__dirname, '../../uploads/foods');
const tmpUploadsDir = path.join('/tmp', 'uploads', 'foods');

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
    const uniqueName = `${Date.now()}-${file.originalname.replace(/\s+/g, '')}`;
    cb(null, uniqueName);
  },
});

const fileFilter = (_req, file, cb) => {
  const allowed = /jpeg|jpg|png|webp/;
  cb(null, allowed.test(file.mimetype));
};

export const uploadFoodImage = multer({
  storage,
  fileFilter,
  limits: {fileSize: 5 * 1024 * 1024},
});

const buildFoodPayload = (body = {}, imageUrl) => {
  const name = String(body.name ?? '').trim();
  const payload = {
    name,
    category: String(body.category ?? 'Snacks').trim() || 'Snacks',
    itemType: 'food',
    price: Math.max(0, Number(body.price ?? 0) || 0),
    // Stock is optional for restaurant made-to-order; availability uses status
    stock: Math.max(0, Number(body.stock ?? 0) || 0),
    unit: String(body.unit ?? 'Plate').trim() || 'Plate',
    isPackaged:
      body.isPackaged === true || body.isPackaged === 'true' || body.isPackaged === '1',
    description: String(body.description ?? '').trim(),
    isVeg: body.isVeg === true || body.isVeg === 'true' || body.isVeg === '1',
    // Available → Active, Not Available → Inactive
    status:
      String(body.status ?? 'Active') === 'Inactive' ||
      String(body.status ?? '').toLowerCase() === 'not available'
        ? 'Inactive'
        : 'Active',
  };

  if (imageUrl !== undefined) {
    payload.imageUrl = imageUrl;
  } else if (body.imageUrl !== undefined) {
    payload.imageUrl = body.imageUrl || null;
  }

  if (body.createdBy !== undefined) {
    payload.createdBy = body.createdBy;
  }

  return {name, payload};
};

const resolveImageUrl = async req => {
  if (!req.file?.path) return undefined;
  try {
    // uploadOnCloudinary returns the secure_url string (Cloudinary CDN URL)
    const uploadedUrl = await uploadOnCloudinary(req.file.path, {
      folder: 'woowoo/foods',
    });
    return uploadedUrl || null;
  } catch (error) {
    console.error('food image upload error:', error);
    return null;
  }
};

export const createFood = async (req, res) => {
  try {
    const imageUrl = await resolveImageUrl(req);
    const {name, payload} = buildFoodPayload(req.body, imageUrl);

    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Food name is required.',
      });
    }

    const staffFromReq = {
      m_staff_id: req.user?.userId ?? null,
      m_staff_name: req.user?.name ?? null,
      m_staff_email: req.user?.email ?? null,
    };

    const food = await Food.create({
      ...payload,
      createdBy: payload.createdBy ?? staffFromReq,
    });

    return res.status(201).json({
      success: true,
      message: 'Food created successfully.',
      food,
    });
  } catch (error) {
    console.error('createFood error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to create food.',
    });
  }
};

export const getFoods = async (req, res) => {
  try {
    const {search = '', category, status} = req.query;
    const query = {};

    if (category && String(category).trim() && String(category) !== 'All') {
      query.category = String(category).trim();
    }
    if (status && String(status).trim() && String(status) !== 'All') {
      query.status = String(status).trim() === 'Inactive' ? 'Inactive' : 'Active';
    }

    const s = String(search).trim();
    if (s) {
      query.$or = [
        {name: {$regex: s, $options: 'i'}},
        {category: {$regex: s, $options: 'i'}},
        {description: {$regex: s, $options: 'i'}},
      ];
    }

    const foods = await Food.find(query).sort({createdAt: -1});
    return res.status(200).json({
      success: true,
      message: 'Foods fetched successfully.',
      foods,
    });
  } catch (error) {
    console.error('getFoods error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch foods.',
    });
  }
};

export const getFoodById = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid food id.'});
    }
    const food = await Food.findById(id);
    if (!food) {
      return res.status(404).json({success: false, message: 'Food not found.'});
    }
    return res.status(200).json({success: true, food});
  } catch (error) {
    console.error('getFoodById error:', error);
    return res.status(500).json({success: false, message: 'Failed to fetch food.'});
  }
};

export const updateFood = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid food id.'});
    }

    const imageUrl = await resolveImageUrl(req);
    const {name, payload} = buildFoodPayload(req.body, imageUrl);

    if (req.body.name !== undefined && !name) {
      return res.status(400).json({success: false, message: 'Food name is required.'});
    }

    const food = await Food.findByIdAndUpdate(id, payload, {
      new: true,
      runValidators: true,
    });

    if (!food) {
      return res.status(404).json({success: false, message: 'Food not found.'});
    }

    return res.status(200).json({
      success: true,
      message: 'Food updated successfully.',
      food,
    });
  } catch (error) {
    console.error('updateFood error:', error);
    return res.status(500).json({success: false, message: 'Failed to update food.'});
  }
};

export const deleteFood = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid food id.'});
    }
    const food = await Food.findByIdAndDelete(id);
    if (!food) {
      return res.status(404).json({success: false, message: 'Food not found.'});
    }
    return res.status(200).json({
      success: true,
      message: 'Food deleted successfully.',
    });
  } catch (error) {
    console.error('deleteFood error:', error);
    return res.status(500).json({success: false, message: 'Failed to delete food.'});
  }
};

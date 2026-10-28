import mongoose from 'mongoose';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import Space, {
  SPACE_DAYS,
  SPACE_TYPES,
  SPACE_STATUSES,
  EXCLUSIVE_CATEGORIES,
  COWORKING_CATEGORIES,
  ALL_SPACE_CATEGORIES,
} from '../models/space.model.js';
import {uploadOnCloudinary} from '../utils/cloudinary.js';

export const generateNextSpaceCode = async () => {
  try {
    const list = await Space.find({spaceCode: {$regex: /^SP-\d+$/i}})
      .select('spaceCode')
      .lean();
    let maxNum = 0;
    for (const s of list) {
      const code = s.spaceCode || '';
      const match = code.match(/SP-(\d+)/i);
      if (match) {
        const num = parseInt(match[1], 10);
        if (!Number.isNaN(num) && num > maxNum) {
          maxNum = num;
        }
      }
    }
    if (maxNum > 0) {
      return `SP-${String(maxNum + 1).padStart(3, '0')}`;
    }
    const count = await Space.countDocuments();
    return `SP-${String(count + 1).padStart(3, '0')}`;
  } catch {
    return 'SP-001';
  }
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const localUploadsDir = path.resolve(__dirname, '../../uploads/spaces');
const tmpUploadsDir = path.join('/tmp', 'uploads', 'spaces');

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

export const uploadSpaceImage = multer({
  storage,
  fileFilter,
  limits: {fileSize: 5 * 1024 * 1024},
});

const ALLOWED_STATUS = new Set(['Available', 'Booked', 'Maintenance']);
const DAY_SET = new Set(SPACE_DAYS);

const escapeRegex = value =>
  String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeStatus = value => {
  const status = String(value || 'Available').trim();
  return ALLOWED_STATUS.has(status) ? status : 'Available';
};

const toMoney = value => Math.max(0, Number(value ?? 0) || 0);

/**
 * Normalize day from request / legacy docs.
 * Accepts: Weekday|Weekend|weekday|weekend
 * Legacy dual-price docs without `day` → null (caller expands).
 */
export const normalizeDay = value => {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'weekday') return 'Weekday';
  if (raw === 'weekend') return 'Weekend';
  return null;
};

const nameDayClash = async (name, day, excludeId = null) => {
  const query = {
    name: new RegExp(`^${escapeRegex(name)}$`, 'i'),
    day,
  };
  if (excludeId) {
    query._id = {$ne: excludeId};
  }
  return Space.findOne(query).select('_id name day').lean();
};

/**
 * Legacy docs stored weekdayPrice + weekendPrice on one row.
 * Expand into one or two list rows without rewriting DB aggressively.
 */
const expandLegacySpace = doc => {
  const hasWeekdayField =
    doc.weekdayPrice !== undefined && doc.weekdayPrice !== null;
  const hasWeekendField =
    doc.weekendPrice !== undefined && doc.weekendPrice !== null;

  if (!hasWeekdayField && !hasWeekendField) {
    return [
      {
        ...doc,
        day: normalizeDay(doc.day) || 'Weekday',
        price: toMoney(doc.price),
      },
    ];
  }

  const rows = [];
  const weekday = toMoney(doc.weekdayPrice ?? doc.price);
  const weekend = toMoney(doc.weekendPrice ?? doc.price);

  rows.push({
    ...doc,
    day: 'Weekday',
    price: weekday,
    _legacyExpanded: true,
    _legacySourceId: String(doc._id),
  });

  // Only emit a weekend twin when weekend price was explicitly set
  // (including 0) on the dual-price document.
  if (hasWeekendField) {
    rows.push({
      ...doc,
      // Synthetic id so FE can distinguish rows; edit should create/migrate
      _id: `${doc._id}:Weekend`,
      day: 'Weekend',
      price: weekend,
      _legacyExpanded: true,
      _legacySourceId: String(doc._id),
      _legacyDay: 'Weekend',
    });
  }

  return rows;
};

export const inferSpaceType = doc => {
  const raw = String(doc?.spaceType || '').trim().toLowerCase();
  if (raw === 'coworking') return 'Coworking';
  if (raw === 'exclusive') return 'Exclusive';

  const cat = String(doc?.category || '').trim();
  if (COWORKING_CATEGORIES.some(c => c.toLowerCase() === cat.toLowerCase())) {
    return 'Coworking';
  }
  if (EXCLUSIVE_CATEGORIES.some(c => c.toLowerCase() === cat.toLowerCase())) {
    return 'Exclusive';
  }
  if (cat.toLowerCase() === 'coworking' || cat.toLowerCase().includes('cowork')) {
    return 'Coworking';
  }

  const name = String(doc?.name || '').trim().toLowerCase();
  if (
    name.includes('cowork') ||
    name.includes('hot desk') ||
    name.includes('desk pass') ||
    name.includes('flexi desk') ||
    name.includes('dedicated desk') ||
    name.includes('meeting pod') ||
    name.includes('open workspace')
  ) {
    return 'Coworking';
  }
  return 'Exclusive';
};

const serializeSpace = doc => {
  const plain =
    typeof doc?.toObject === 'function' ? doc.toObject() : {...doc};
  const day = normalizeDay(plain.day);
  const spaceType = inferSpaceType(plain);
  const spaceCode =
    plain.spaceCode || `SP-${String(plain._id || '').slice(-5).toUpperCase()}`;

  const {createdBy: _createdBy, ...safe} = plain;

  // New-model docs always have day
  if (day) {
    return {
      ...safe,
      spaceCode,
      spaceType,
      day,
      price: toMoney(plain.price),
    };
  }

  // Legacy dual-price / missing day — expand for list consumers
  return expandLegacySpace(safe).map(r => {
    const {createdBy: _staff, ...row} = r;
    return {
      ...row,
      spaceCode: r.spaceCode || spaceCode,
      spaceType: inferSpaceType(r),
    };
  });
};

const buildSpacePayload = (body = {}, imageUrl, {partial = false} = {}) => {
  const name = String(body.name ?? '').trim();
  const payload = {};

  if (!partial || body.name !== undefined) payload.name = name;
  if (!partial || body.spaceCode !== undefined) {
    payload.spaceCode = String(body.spaceCode ?? '').trim().toUpperCase();
  }
  if (!partial || body.category !== undefined) {
    payload.category = String(body.category ?? 'Studio').trim() || 'Studio';
  }
  if (!partial || body.spaceType !== undefined) {
    const rawType = String(body.spaceType ?? '').trim().toLowerCase();
    if (rawType === 'coworking') {
      payload.spaceType = 'Coworking';
    } else if (rawType === 'exclusive') {
      payload.spaceType = 'Exclusive';
    } else if (!partial) {
      const cat = String(payload.category ?? body.category ?? '').trim();
      if (COWORKING_CATEGORIES.some(c => c.toLowerCase() === cat.toLowerCase())) {
        payload.spaceType = 'Coworking';
      } else {
        payload.spaceType = 'Exclusive';
      }
    }
  } else if (!partial) {
    const cat = String(payload.category ?? body.category ?? '').trim();
    if (COWORKING_CATEGORIES.some(c => c.toLowerCase() === cat.toLowerCase())) {
      payload.spaceType = 'Coworking';
    } else {
      payload.spaceType = 'Exclusive';
    }
  }
  payload.itemType = 'space';

  if (!partial || body.day !== undefined) {
    const day = normalizeDay(body.day) || 'Weekday';
    if (!DAY_SET.has(day)) {
      return {name, payload, error: 'Day must be Weekday or Weekend.'};
    }
    payload.day = day;
  }

  if (!partial || body.price !== undefined) {
    // Prefer explicit price; fall back to legacy weekday/weekend fields if sent
    if (body.price !== undefined && body.price !== '') {
      payload.price = toMoney(body.price);
    } else if (body.weekdayPrice !== undefined && body.weekdayPrice !== '') {
      payload.price = toMoney(body.weekdayPrice);
      if (!payload.day) payload.day = 'Weekday';
    } else if (body.weekendPrice !== undefined && body.weekendPrice !== '') {
      payload.price = toMoney(body.weekendPrice);
      if (!payload.day) payload.day = 'Weekend';
    } else if (!partial) {
      payload.price = 0;
    }
  }

  if (!partial || body.capacity !== undefined) {
    payload.capacity = Math.max(1, Number(body.capacity ?? 1) || 1);
  }
  if (!partial || body.status !== undefined) {
    payload.status = normalizeStatus(body.status);
  }
  if (!partial || body.description !== undefined) {
    payload.description = String(body.description ?? '').trim();
  }

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
    const uploadedUrl = await uploadOnCloudinary(req.file.path, {
      folder: 'woowoo/spaces',
    });
    return uploadedUrl || null;
  } catch (error) {
    console.error('space image upload error:', error);
    return null;
  }
};

export const createSpace = async (req, res) => {
  try {
    const imageUrl = await resolveImageUrl(req);
    const {name, payload, error} = buildSpacePayload(req.body, imageUrl);

    if (error) {
      return res.status(400).json({success: false, message: error});
    }
    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Space name is required.',
      });
    }

    const staffFromReq = {
      m_staff_id: req.user?.userId ?? null,
      m_staff_name: req.user?.name ?? null,
      m_staff_email: req.user?.email ?? null,
    };
    const createdBy = payload.createdBy ?? staffFromReq;

    if (!payload.spaceCode) {
      payload.spaceCode = await generateNextSpaceCode();
    }

    const createBothDays =
      String(req.body.createBothDays).toLowerCase() === 'true' ||
      req.body.createBothDays === true ||
      String(req.body.hasBothDays).toLowerCase() === 'true' ||
      req.body.hasBothDays === true;

    if (createBothDays) {
      const weekdayPrice = toMoney(req.body.weekdayPrice ?? payload.price);
      const weekendPrice = toMoney(req.body.weekendPrice ?? payload.price);
      const weekdayStatus = normalizeStatus(
        req.body.weekdayStatus ?? payload.status,
      );
      const weekendStatus = normalizeStatus(
        req.body.weekendStatus ?? payload.status,
      );

      const clashWeekday = await nameDayClash(name, 'Weekday');
      if (clashWeekday) {
        return res.status(409).json({
          success: false,
          message: `A space named "${name}" already exists for Weekday.`,
        });
      }

      const clashWeekend = await nameDayClash(name, 'Weekend');
      if (clashWeekend) {
        return res.status(409).json({
          success: false,
          message: `A space named "${name}" already exists for Weekend.`,
        });
      }

      const baseDoc = {
        name,
        spaceCode: payload.spaceCode,
        spaceType: payload.spaceType || 'Exclusive',
        category: payload.category || 'Studio',
        itemType: 'space',
        capacity: payload.capacity || 1,
        description: payload.description || '',
        imageUrl: payload.imageUrl ?? null,
        createdBy,
      };

      const weekdayDoc = await Space.create({
        ...baseDoc,
        day: 'Weekday',
        price: weekdayPrice,
        status: weekdayStatus,
      });

      const weekendDoc = await Space.create({
        ...baseDoc,
        day: 'Weekend',
        price: weekendPrice,
        status: weekendStatus,
      });

      return res.status(201).json({
        success: true,
        message: 'Spaces created successfully for Weekday and Weekend.',
        space: serializeSpace(weekdayDoc),
        spaces: [serializeSpace(weekdayDoc), serializeSpace(weekendDoc)],
      });
    }

    if (!payload.day) payload.day = 'Weekday';
    if (payload.price === undefined) payload.price = 0;

    const clash = await nameDayClash(name, payload.day);
    if (clash) {
      return res.status(409).json({
        success: false,
        message: `A space named "${name}" already exists for ${payload.day}.`,
      });
    }

    // Strip legacy dual-price fields if somehow present
    delete payload.weekdayPrice;
    delete payload.weekendPrice;

    const space = await Space.create({
      ...payload,
      createdBy,
    });

    return res.status(201).json({
      success: true,
      message: 'Space created successfully.',
      space: serializeSpace(space),
    });
  } catch (error) {
    console.error('createSpace error:', error);
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'A space with this name and day already exists.',
      });
    }
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to create space.',
    });
  }
};

export const getSpaces = async (req, res) => {
  try {
    const {search = '', category, status, day, spaceType} = req.query;
    const query = {};

    if (category && String(category).trim() && String(category) !== 'All') {
      query.category = String(category).trim();
    }
    if (spaceType && String(spaceType).trim() && String(spaceType) !== 'All') {
      const st = String(spaceType).trim().toLowerCase();
      if (st === 'coworking') {
        query.$or = [
          {spaceType: 'Coworking'},
          {
            $and: [
              {spaceType: {$nin: ['Exclusive', 'Coworking']}},
              {
                $or: [
                  {category: {$in: COWORKING_CATEGORIES}},
                  {category: /cowork/i},
                  {name: /cowork|hot desk|desk pass|flexi desk|dedicated desk|meeting pod|open workspace/i},
                ],
              },
            ],
          },
        ];
      } else if (st === 'exclusive') {
        query.$or = [
          {spaceType: 'Exclusive'},
          {
            $and: [
              {spaceType: {$nin: ['Exclusive', 'Coworking']}},
              {category: {$in: EXCLUSIVE_CATEGORIES}},
            ],
          },
          {
            $and: [
              {spaceType: {$nin: ['Exclusive', 'Coworking']}},
              {category: {$nin: COWORKING_CATEGORIES}},
              {name: {$not: /cowork|hot desk|desk pass|flexi desk|dedicated desk|meeting pod|open workspace/i}},
            ],
          },
        ];
      }
    }
    if (status && String(status).trim() && String(status) !== 'All') {
      query.status = normalizeStatus(status);
    }
    const dayFilter = normalizeDay(day);
    if (dayFilter) {
      query.day = dayFilter;
    }

    const s = String(search).trim();
    if (s) {
      query.$or = [
        {name: {$regex: s, $options: 'i'}},
        {spaceCode: {$regex: s, $options: 'i'}},
        {category: {$regex: s, $options: 'i'}},
        {description: {$regex: s, $options: 'i'}},
      ];
    }

    const docs = await Space.find(query).sort({name: 1, day: 1, createdAt: -1});
    const spaces = docs.flatMap(doc => {
      const serialized = serializeSpace(doc);
      return Array.isArray(serialized) ? serialized : [serialized];
    });

    return res.status(200).json({
      success: true,
      message: 'Spaces fetched successfully.',
      spaces,
    });
  } catch (error) {
    console.error('getSpaces error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch spaces.',
    });
  }
};

const publicSpaceCard = docs => {
  const rows = docs.flatMap(doc => {
    const serialized = serializeSpace(doc);
    return Array.isArray(serialized) ? serialized : [serialized];
  });
  const first = rows[0];
  if (!first) return null;
  let weekdayPrice = null;
  let weekendPrice = null;
  let imageUrl = null;
  let description = '';
  let capacity = 0;
  for (const row of rows) {
    const price = Math.max(0, Number(row.price) || 0);
    if (String(row.day || '').toLowerCase() === 'weekend') weekendPrice = price;
    else weekdayPrice = price;
    if (!imageUrl && row.imageUrl) imageUrl = String(row.imageUrl).trim();
    if (!description && row.description) description = String(row.description).trim();
    capacity = Math.max(capacity, Number(row.capacity) || 0);
  }
  const prices = [weekdayPrice, weekendPrice].filter(value => value != null);
  return {
    id: String(first._id),
    name: String(first.name || '').trim(),
    category: String(first.category || '').trim(),
    spaceType: String(first.spaceType || '').trim(),
    description,
    capacity,
    status: 'Available',
    imageUrl: imageUrl || null,
    weekdayPrice,
    weekendPrice,
    fromPrice: prices.length ? Math.min(...prices) : 0,
  };
};

/** One public space for a shared link. No staff fields or booking records. */
export const getCustomerSpaceById = async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({success: false, message: 'Space not found'});
    }
    const space = await Space.findById(id).lean();
    if (!space) {
      return res.status(404).json({success: false, message: 'Space not found'});
    }
    const name = String(space.name || '').trim();
    const siblings = name
      ? await Space.find({
          name: new RegExp(`^${escapeRegex(name)}$`, 'i'),
          status: 'Available',
        }).lean()
      : [];
    if (!siblings.length) {
      return res.status(404).json({success: false, message: 'Space not found'});
    }
    const card = publicSpaceCard(siblings);
    if (!card) {
      return res.status(404).json({success: false, message: 'Space not found'});
    }
    card.id = id;
    return res.status(200).json({success: true, space: card});
  } catch (error) {
    console.error('getCustomerSpaceById error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch space.',
    });
  }
};

export const getSpaceById = async (req, res) => {
  try {
    const {id} = req.params;

    // Legacy expanded weekend id: `<objectId>:Weekend`
    if (String(id).includes(':')) {
      const [sourceId, legacyDay] = String(id).split(':');
      if (!mongoose.Types.ObjectId.isValid(sourceId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid space id.',
        });
      }
      const source = await Space.findById(sourceId).lean();
      if (!source) {
        return res.status(404).json({
          success: false,
          message: 'Space not found.',
        });
      }
      const day = normalizeDay(legacyDay) || 'Weekend';
      const price =
        day === 'Weekend'
          ? toMoney(source.weekendPrice ?? source.price)
          : toMoney(source.weekdayPrice ?? source.price);
      return res.status(200).json({
        success: true,
        message: 'Space fetched successfully.',
        space: {
          ...source,
          _id: id,
          day,
          price,
          _legacyExpanded: true,
          _legacySourceId: sourceId,
        },
      });
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid space id.',
      });
    }

    const space = await Space.findById(id);
    if (!space) {
      return res.status(404).json({
        success: false,
        message: 'Space not found.',
      });
    }

    const serialized = serializeSpace(space);
    return res.status(200).json({
      success: true,
      message: 'Space fetched successfully.',
      space: Array.isArray(serialized) ? serialized[0] : serialized,
    });
  } catch (error) {
    console.error('getSpaceById error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch space.',
    });
  }
};

export const updateSpace = async (req, res) => {
  try {
    let {id} = req.params;
    let legacySourceId = null;
    let legacyTargetDay = null;

    if (String(id).includes(':')) {
      const [sourceId, legacyDay] = String(id).split(':');
      legacySourceId = sourceId;
      legacyTargetDay = normalizeDay(legacyDay) || 'Weekend';
      id = sourceId;
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid space id.',
      });
    }

    const existing = await Space.findById(id);
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: 'Space not found.',
      });
    }

    const imageUrl = await resolveImageUrl(req);
    const {name, payload, error} = buildSpacePayload(req.body, imageUrl, {
      partial: true,
    });

    if (error) {
      return res.status(400).json({success: false, message: error});
    }
    if (req.body.name !== undefined && !name) {
      return res.status(400).json({
        success: false,
        message: 'Space name is required.',
      });
    }

    // Editing a legacy expanded "Weekend" twin → promote to real Weekend row
    if (legacySourceId && legacyTargetDay === 'Weekend') {
      const nextName = payload.name || existing.name;
      const nextDay = payload.day || 'Weekend';
      const nextPrice =
        payload.price !== undefined
          ? payload.price
          : toMoney(existing.weekendPrice ?? existing.price);

      const clash = await nameDayClash(nextName, nextDay, existing._id);
      // Allow if clash is the same legacy source being converted
      if (clash && String(clash._id) !== String(existing._id)) {
        // If weekend row already exists as its own doc, update that instead
        const weekendDoc = await Space.findOne({
          name: new RegExp(`^${escapeRegex(nextName)}$`, 'i'),
          day: 'Weekend',
        });
        if (weekendDoc) {
          Object.assign(weekendDoc, {
            ...payload,
            name: nextName,
            day: 'Weekend',
            price: nextPrice,
          });
          delete weekendDoc.weekdayPrice;
          delete weekendDoc.weekendPrice;
          await weekendDoc.save();
          return res.status(200).json({
            success: true,
            message: 'Space updated successfully.',
            space: serializeSpace(weekendDoc),
          });
        }
        return res.status(409).json({
          success: false,
          message: `A space named "${nextName}" already exists for ${nextDay}.`,
        });
      }

      // Convert legacy source: keep Weekday on original, create Weekend doc
      const existingDay = normalizeDay(existing.day);
      if (!existingDay) {
        existing.day = 'Weekday';
        existing.price = toMoney(existing.weekdayPrice ?? existing.price);
        existing.set('weekdayPrice', undefined);
        existing.set('weekendPrice', undefined);
        await existing.save();
      }

      const weekendPayload = {
        name: nextName,
        spaceCode: payload.spaceCode ?? existing.spaceCode ?? '',
        spaceType: payload.spaceType ?? existing.spaceType ?? 'Exclusive',
        category: payload.category ?? existing.category,
        itemType: 'space',
        day: 'Weekend',
        price: nextPrice,
        capacity: payload.capacity ?? existing.capacity,
        status: payload.status ?? existing.status,
        description:
          payload.description !== undefined
            ? payload.description
            : existing.description,
        imageUrl:
          payload.imageUrl !== undefined
            ? payload.imageUrl
            : existing.imageUrl,
        createdBy: existing.createdBy,
      };

      try {
        const created = await Space.create(weekendPayload);
        return res.status(200).json({
          success: true,
          message: 'Space updated successfully.',
          space: serializeSpace(created),
        });
      } catch (createErr) {
        if (createErr?.code === 11000) {
          return res.status(409).json({
            success: false,
            message: `A space named "${nextName}" already exists for Weekend.`,
          });
        }
        throw createErr;
      }
    }

    const nextName = payload.name !== undefined ? payload.name : existing.name;
    const nextDay =
      payload.day !== undefined
        ? payload.day
        : normalizeDay(existing.day) || 'Weekday';

    const clash = await nameDayClash(nextName, nextDay, existing._id);
    if (clash) {
      return res.status(409).json({
        success: false,
        message: `A space named "${nextName}" already exists for ${nextDay}.`,
      });
    }

    // Migrating legacy dual-price doc into single-day model
    if (!normalizeDay(existing.day)) {
      payload.day = nextDay;
      if (payload.price === undefined) {
        payload.price =
          nextDay === 'Weekend'
            ? toMoney(existing.weekendPrice ?? existing.price)
            : toMoney(existing.weekdayPrice ?? existing.price);
      }
    }

    Object.assign(existing, payload);
    // Clear legacy fields so list no longer expands this doc
    existing.set('weekdayPrice', undefined);
    existing.set('weekendPrice', undefined);
    await existing.save();

    return res.status(200).json({
      success: true,
      message: 'Space updated successfully.',
      space: serializeSpace(existing),
    });
  } catch (error) {
    console.error('updateSpace error:', error);
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'A space with this name and day already exists.',
      });
    }
    return res.status(500).json({
      success: false,
      message: 'Failed to update space.',
    });
  }
};

export const deleteSpace = async (req, res) => {
  try {
    let {id} = req.params;

    // Deleting synthetic Weekend expansion → create nothing; strip weekend from legacy
    if (String(id).includes(':')) {
      const [sourceId, legacyDay] = String(id).split(':');
      if (!mongoose.Types.ObjectId.isValid(sourceId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid space id.',
        });
      }
      const source = await Space.findById(sourceId);
      if (!source) {
        return res.status(404).json({
          success: false,
          message: 'Space not found.',
        });
      }
      if (normalizeDay(legacyDay) === 'Weekend') {
        source.set('weekendPrice', undefined);
        if (!normalizeDay(source.day)) {
          source.day = 'Weekday';
          source.price = toMoney(source.weekdayPrice ?? source.price);
          source.set('weekdayPrice', undefined);
        }
        await source.save();
        return res.status(200).json({
          success: true,
          message: 'Space deleted successfully.',
        });
      }
      id = sourceId;
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid space id.',
      });
    }

    const space = await Space.findByIdAndDelete(id);
    if (!space) {
      return res.status(404).json({
        success: false,
        message: 'Space not found.',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Space deleted successfully.',
    });
  } catch (error) {
    console.error('deleteSpace error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete space.',
    });
  }
};

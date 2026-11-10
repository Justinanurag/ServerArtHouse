import Segment from '../models/segment.model.js';
import Product from '../models/product.model.js';

const cleanName = value => String(value ?? '').trim();

const findByName = async (name, excludeId = null) => {
  const query = {
    name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
  };
  if (excludeId) query._id = {$ne: excludeId};
  return Segment.findOne(query).lean();
};

export const getSegments = async (_req, res) => {
  try {
    const segments = await Segment.find().sort({name: 1}).lean();
    return res.status(200).json({success: true, segments});
  } catch (error) {
    console.error('getSegments error:', error);
    return res.status(500).json({success: false, message: 'Failed to fetch segments'});
  }
};

export const getSegmentsById = async (req, res) => {
  try {
    const segment = await Segment.findById(req.params.id).lean();
    if (!segment) {
      return res.status(404).json({success: false, message: 'Segment not found'});
    }
    return res.status(200).json({success: true, segment});
  } catch (error) {
    console.error('getSegmentsById error:', error);
    return res.status(500).json({success: false, message: 'Failed to fetch segment'});
  }
};

export const createSegments = async (req, res) => {
  try {
    const body = req.body || {};
    const incoming = Array.isArray(body.segments)
      ? body.segments
      : [{name: body.name || body.segmentName}];
    const names = [
      ...new Set(
        incoming
          .map(row => cleanName(row?.name || row?.segmentName || row))
          .filter(Boolean),
      ),
    ];
    if (!names.length) {
      return res.status(400).json({success: false, message: 'Segment name is required'});
    }

    const created = [];
    const existing = [];
    for (const name of names) {
      const found = await findByName(name);
      if (found) {
        existing.push(found);
        continue;
      }
      created.push(await Segment.create({name}));
    }

    return res.status(created.length ? 201 : 200).json({
      success: true,
      segments: created,
      existing,
    });
  } catch (error) {
    console.error('createSegments error:', error);
    return res.status(500).json({success: false, message: 'Failed to create segment'});
  }
};

export const updateSegments = async (req, res) => {
  try {
    const name = cleanName(req.body?.name || req.body?.segmentName);
    if (!name) {
      return res.status(400).json({success: false, message: 'Segment name is required'});
    }
    const current = await Segment.findById(req.params.id);
    if (!current) {
      return res.status(404).json({success: false, message: 'Segment not found'});
    }
    const clash = await findByName(name, current._id);
    if (clash) {
      return res.status(409).json({success: false, message: 'A segment with this name already exists'});
    }
    const previous = current.name;
    current.name = name;
    await current.save();
    if (previous !== name) {
      const id = String(current._id);
      const products = await Product.find({
        $or: [
          {segmentId: id},
          {segment: previous},
          {'segments.segmentId': id},
          {'segments.name': previous},
        ],
      });
      for (const product of products) {
        const rows = Array.isArray(product.segments) ? product.segments : [];
        let touched = false;
        for (const row of rows) {
          if (String(row.segmentId || '') === id || row.name === previous) {
            row.segmentId = id;
            row.name = name;
            touched = true;
          }
        }
        if (!rows.length && (String(product.segmentId || '') === id || product.segment === previous)) {
          product.segments = [{segmentId: id, name}];
          touched = true;
        }
        if (!touched) continue;
        product.segment = product.segments.map(row => row.name).filter(Boolean).join(', ');
        product.segmentId = product.segments[0]?.segmentId || id;
        await product.save();
      }
    }
    return res.status(200).json({success: true, segment: current});
  } catch (error) {
    console.error('updateSegments error:', error);
    return res.status(500).json({success: false, message: 'Failed to update segment'});
  }
};

export const deleteSegments = async (req, res) => {
  try {
    const current = await Segment.findById(req.params.id);
    if (!current) {
      return res.status(404).json({success: false, message: 'Segment not found'});
    }
    const used = await Product.findOne({
      $or: [
        {segmentId: String(current._id)},
        {segment: current.name},
        {'segments.segmentId': String(current._id)},
        {'segments.name': current.name},
      ],
    }).select('_id');
    if (used) {
      return res.status(400).json({
        success: false,
        message: `Segment "${current.name}" is used on a product and cannot be deleted`,
      });
    }
    await current.deleteOne();
    return res.status(200).json({success: true, message: 'Segment deleted'});
  } catch (error) {
    console.error('deleteSegments error:', error);
    return res.status(500).json({success: false, message: 'Failed to delete segment'});
  }
};

import mongoose from 'mongoose';
import ErpActivity from '../models/erpActivity.model.js';
import {readCompanyId} from '../utils/activity.util.js';

const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const readDate = value => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const buildQuery = req => {
  const query = {};
  const and = [];
  const companyId = readCompanyId(req.staff) || readCompanyId(req.user);
  if (companyId) {
    and.push({$or: [{companyId}, {companyId: ''}, {companyId: null}]});
  }

  if (req.query.module) query.module = String(req.query.module);
  if (req.query.action) query.action = String(req.query.action).toUpperCase();
  if (req.query.userId) query.userId = req.query.userId;
  if (req.query.status === 'success' || req.query.status === 'failure') {
    query.status = req.query.status;
  }
  if (req.query.source) query.source = String(req.query.source);
  if (req.query.transactionType) query.transactionType = String(req.query.transactionType);

  const from = readDate(req.query.from);
  const to = readDate(req.query.to);
  if (from || to) {
    query.createdAt = {};
    if (from) query.createdAt.$gte = from;
    if (to) query.createdAt.$lte = to;
  }

  const search = String(req.query.search || '').trim();
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    and.push({
      $or: [
        {resourceName: pattern},
        {userName: pattern},
        {description: pattern},
        {relatedName: pattern},
      ],
    });
  }
  if (and.length) query.$and = and;
  return query;
};

const validateFilters = req => {
  if (req.query.userId && !mongoose.isValidObjectId(req.query.userId)) {
    return 'userId must be a valid id.';
  }
  const from = req.query.from ? readDate(req.query.from) : null;
  const to = req.query.to ? readDate(req.query.to) : null;
  if (req.query.from && !from) return 'from must be a valid date.';
  if (req.query.to && !to) return 'to must be a valid date.';
  if (from && to && from > to) return 'from must be before to.';
  return '';
};

const dateKey = value =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));

const dateLabel = value =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(new Date(value));

const groupByDate = items => {
  const today = dateKey(new Date());
  const yesterdayDate = new Date();
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = dateKey(yesterdayDate);
  const groups = [];
  for (const item of items) {
    const key = dateKey(item.createdAt);
    const last = groups[groups.length - 1];
    const prefix = key === today ? 'Today — ' : key === yesterday ? 'Yesterday — ' : '';
    if (!last || last.date !== key) {
      groups.push({date: key, label: `${prefix}${dateLabel(item.createdAt)}`, items: [item]});
    } else {
      last.items.push(item);
    }
  }
  return groups;
};

const loadPage = async req => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
  const sort = req.query.sort === 'oldest' ? {createdAt: 1} : {createdAt: -1};
  const query = buildQuery(req);
  const [items, total] = await Promise.all([
    ErpActivity.find(query).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
    ErpActivity.countDocuments(query),
  ]);
  return {items, page, limit, total, pages: Math.ceil(total / limit) || 0};
};

const sendError = (res, error) => {
  console.error('activity api error:', error?.message || error);
  return res.status(500).json({success: false, message: 'Failed to load activities.'});
};

export const listActivities = async (req, res) => {
  const invalid = validateFilters(req);
  if (invalid) return res.status(400).json({success: false, message: invalid});
  try {
    const page = await loadPage(req);
    return res.json({success: true, ...page});
  } catch (error) {
    return sendError(res, error);
  }
};

export const timelineActivities = async (req, res) => {
  const invalid = validateFilters(req);
  if (invalid) return res.status(400).json({success: false, message: invalid});
  try {
    const page = await loadPage(req);
    return res.json({success: true, ...page, groups: groupByDate(page.items)});
  } catch (error) {
    return sendError(res, error);
  }
};

export const getActivity = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(404).json({success: false, message: 'Activity not found'});
  }
  try {
    const query = {_id: req.params.id, ...buildQuery({...req, query: {}})};
    const item = await ErpActivity.findOne(query).lean();
    if (!item) return res.status(404).json({success: false, message: 'Activity not found'});
    return res.json({success: true, item});
  } catch (error) {
    return sendError(res, error);
  }
};

const countAction = (query, actions) => {
  if (query.action && !actions.includes(query.action)) return Promise.resolve(0);
  return ErpActivity.countDocuments({
    ...query,
    action: query.action || {$in: actions},
  });
};

export const activityStats = async (req, res) => {
  const invalid = validateFilters(req);
  if (invalid) return res.status(400).json({success: false, message: invalid});
  try {
    const query = buildQuery(req);
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    const rangeStart = query.createdAt?.$gte
      ? new Date(Math.max(start.getTime(), new Date(query.createdAt.$gte).getTime()))
      : start;
    const rangeEnd = query.createdAt?.$lte
      ? new Date(Math.min(end.getTime(), new Date(query.createdAt.$lte).getTime()))
      : end;
    const todayCount = rangeStart > rangeEnd
      ? 0
      : await ErpActivity.countDocuments({
          ...query,
          createdAt: {...(query.createdAt || {}), $gte: rangeStart, $lte: rangeEnd},
        });

    const todayBase = {...query};
    delete todayBase.createdAt;
    const [total, created, updated, payments, activeUserIds] = await Promise.all([
      ErpActivity.countDocuments(query),
      countAction(query, ['CREATE']),
      countAction(query, ['UPDATE']),
      ErpActivity.countDocuments({
        ...query,
        $or: [{action: 'PAYMENT'}, {transactionType: 'payment'}],
      }),
      ErpActivity.distinct('userId', {
        ...todayBase,
        userId: {$ne: null},
        createdAt: {$gte: start, $lte: end},
      }),
    ]);
    return res.json({
      success: true,
      stats: {
        total,
        today: todayCount,
        activeUsers: activeUserIds.length,
        created,
        updated,
        payments,
      },
    });
  } catch (error) {
    return sendError(res, error);
  }
};

export const activityUsers = async (req, res) => {
  try {
    const match = buildQuery(req);
    const users = await ErpActivity.aggregate([
      {$match: {...match, userId: {$ne: null}}},
      {$group: {_id: '$userId', userName: {$last: '$userName'}, userEmail: {$last: '$userEmail'}}},
      {$sort: {userName: 1}},
      {$limit: 200},
    ]);
    return res.json({success: true, users});
  } catch (error) {
    return sendError(res, error);
  }
};

export const activityModules = async (req, res) => {
  try {
    const modules = await ErpActivity.distinct('module', buildQuery(req));
    return res.json({success: true, modules: modules.filter(Boolean).sort()});
  } catch (error) {
    return sendError(res, error);
  }
};

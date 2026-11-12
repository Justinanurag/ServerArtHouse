import {randomUUID} from 'crypto';
import {logActivities, logActivity} from '../services/activityLog.service.js';
import {actionFromRequest, describeActivity, isCriticalModule, moduleFromPath} from '../utils/activity.util.js';

const NAME_KEYS = [
  'productName',
  'invoiceNumber',
  'quotationNumber',
  'name',
  'fullName',
  'title',
  'foodName',
  'spaceName',
  'customerName',
  'vendorName',
  'companyName',
  'code',
  'sku',
  'label',
];

const shouldSkip = req => {
  const path = req.path.toLowerCase();
  if (path.startsWith('/api/activities') || path.startsWith('/uploads')) return true;
  if (path.startsWith('/auth/check') || path.startsWith('/auth/request-otp') || path.startsWith('/auth/request-email-otp')) {
    return true;
  }
  return /\/(search|autocomplete|typeahead|check-phone)(\/|$)/.test(path);
};

const pickName = obj => {
  if (!obj || typeof obj !== 'object') return '';
  for (const key of NAME_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
};

const pickId = obj => {
  if (!obj || typeof obj !== 'object') return '';
  const value = obj._id || obj.id;
  if (!value || typeof value === 'object') return value?._id ? String(value._id) : '';
  return String(value);
};

const resourceFromPayload = payload => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const candidates = [payload];
  for (const value of Object.values(payload)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) candidates.push(value);
  }
  for (const obj of candidates) {
    const resourceId = pickId(obj);
    const resourceName = pickName(obj);
    if (resourceId || resourceName) return {resourceId, resourceName};
  }
  return {};
};

const idFromPath = pathname => {
  const tail = String(pathname || '').split('?')[0].split('/').filter(Boolean).pop();
  return /^[a-f0-9]{24}$/i.test(tail || '') ? tail : '';
};

const buildEntry = (req, res, payload) => {
  const audit = req.audit || {};
  const moduleName = audit.module || moduleFromPath(req.originalUrl);
  const action = actionFromRequest(req.method, req.originalUrl, audit.action);
  const failed = res.statusCode >= 400;
  const extracted = resourceFromPayload(payload);
  const described = describeActivity({
    payload,
    body: req.body,
    action,
    moduleName,
    failed,
    pathname: req.originalUrl,
  });
  const genericMessage = typeof payload?.message === 'string' ? payload.message.trim() : '';
  const useGeneric = genericMessage && !/success|failed|error/i.test(genericMessage);
  return {
    action,
    module: moduleName,
    description: audit.description || (useGeneric ? genericMessage : described.description),
    resourceId: String(audit.resourceId || extracted.resourceId || described.resourceId || idFromPath(req.originalUrl) || ''),
    resourceName: String(audit.resourceName || described.resourceName || extracted.resourceName || ''),
    resourceType: String(audit.resourceType || moduleName),
    relatedName: String(audit.relatedName || described.relatedName || ''),
    amount: audit.amount ?? described.amount,
    transactionType: audit.transactionType || described.transactionType || '',
    status: failed ? 'failure' : 'success',
    changes: audit.changes || [],
    metadata: {...described.metadata, ...(audit.metadata || {})},
    userId: audit.userId,
    userName: audit.userName,
    userEmail: audit.userEmail,
    actorType: audit.actorType,
    companyId: audit.companyId,
  };
};

export const requestContext = (req, res, next) => {
  req.requestId = String(req.headers['x-request-id'] || randomUUID());
  res.setHeader('x-request-id', req.requestId);
  next();
};

export const activityLogger = (req, res, next) => {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  if (shouldSkip(req)) return next();

  const persist = async payload => {
    if (req._activityLogged) return;
    req._activityLogged = true;
    const base = buildEntry(req, res, payload);
    const rows = Array.isArray(req.audit?.entries) && req.audit.entries.length
      ? req.audit.entries.map(row => ({...base, ...row, status: base.status}))
      : [base];
    if (isCriticalModule(base.module)) {
      if (rows.length > 1) await logActivities(rows, req);
      else await logActivity(rows[0], req);
      return;
    }
    setImmediate(() => {
      if (rows.length > 1) void logActivities(rows, req);
      else void logActivity(rows[0], req);
    });
  };

  const originalSend = res.send.bind(res);
  res.send = function sendWithActivity(body) {
    let payload = body;
    if (Buffer.isBuffer(body)) payload = null;
    else if (typeof body === 'string') {
      try {
        payload = JSON.parse(body);
      } catch {
        payload = null;
      }
    }
    const critical = isCriticalModule(req.audit?.module || moduleFromPath(req.originalUrl));
    if (critical) {
      return persist(payload).then(() => originalSend(body));
    }
    const result = originalSend(body);
    void persist(payload);
    return result;
  };

  res.on('finish', () => {
    if (!req._activityLogged) void persist(null);
  });

  next();
};

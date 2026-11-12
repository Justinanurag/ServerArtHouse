import ErpActivity from '../models/erpActivity.model.js';
import {readCompanyId, sanitizeChanges, sanitizeValue, sourceFromRequest} from '../utils/activity.util.js';

const actorFromRequest = req => {
  const staff = req?.staff;
  const user = req?.user;
  if (staff || user?.userId) {
    const roleName = staff?.roleId?.name || staff?.role || user?.role || '';
    const role = String(roleName).toLowerCase();
    const source = sourceFromRequest(req);
    let actorType = role === 'admin' ? 'Admin' : 'Staff';
    if (source === 'POS') actorType = 'POS';
    return {
      userId: staff?._id || user?.userId || null,
      userName: staff?.fullName || user?.name || '',
      userEmail: staff?.email || user?.email || '',
      userRole: String(roleName),
      actorType,
      companyId: readCompanyId(staff) || readCompanyId(user),
    };
  }
  if (req?.customer?._id) {
    return {
      userId: req.customer._id,
      userName: req.customer.name || req.customer.fullName || '',
      userEmail: req.customer.email || '',
      actorType: 'Customer',
      userRole: 'Customer',
      companyId: readCompanyId(req.customer),
    };
  }
  return {userId: null, userName: '', userEmail: '', userRole: 'System', actorType: 'System', companyId: ''};
};

const toDoc = (entry, req) => {
  const actor = actorFromRequest(req);
  return {
    ...actor,
    ...entry,
    userId: entry.userId ?? actor.userId,
    userName: entry.userName || actor.userName,
    userEmail: entry.userEmail || actor.userEmail,
    actorType: entry.actorType || actor.actorType,
    userRole: entry.userRole || actor.userRole || '',
    source: entry.source || sourceFromRequest(req),
    relatedName: entry.relatedName || '',
    amount: entry.amount ?? null,
    transactionType: entry.transactionType || '',
    companyId: entry.companyId || actor.companyId || '',
    metadata: sanitizeValue(entry.metadata || {}),
    changes: sanitizeChanges(entry.changes),
    ipAddress: entry.ipAddress || req?.ip || '',
    requestId: entry.requestId || req?.requestId || '',
    method: entry.method || req?.method || '',
    endpoint: entry.endpoint || req?.originalUrl || '',
  };
};

export const logActivity = async (entry, req) => {
  try {
    await ErpActivity.create(toDoc(entry, req));
  } catch (error) {
    console.error('activity log failed:', error?.message || error);
  }
};

export const logActivities = async (entries, req) => {
  try {
    const docs = entries.map(entry => toDoc(entry, req));
    if (docs.length) await ErpActivity.insertMany(docs, {ordered: false});
  } catch (error) {
    console.error('activity bulk log failed:', error?.message || error);
  }
};

import express from 'express';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {attachStaffContext} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';
import {
  activityModules,
  activityStats,
  activityUsers,
  getActivity,
  listActivities,
  timelineActivities,
} from '../controllers/erpActivity.controller.js';

const router = express.Router();

const requireActivityRead = (req, res, next) => {
  const permissions = Array.isArray(req.permissions) ? req.permissions : [];
  const slug = String(req.staff?.roleId?.slug || '').toLowerCase();
  const legacyAdmin = String(req.staff?.role || '').toLowerCase() === 'admin';
  const allowed =
    permissions.includes(PERMISSIONS.ACTIVITY_READ) ||
    legacyAdmin ||
    slug === 'admin' ||
    slug === 'super_admin';

  if (!allowed) {
    return res.status(403).json({
      success: false,
      message: 'Forbidden. You do not have permission to view activities.',
      required: [PERMISSIONS.ACTIVITY_READ],
    });
  }
  return next();
};

router.use(authenticateUser, attachStaffContext, requireActivityRead);

router.get('/', listActivities);
router.get('/timeline', timelineActivities);
router.get('/stats', activityStats);
router.get('/users', activityUsers);
router.get('/modules', activityModules);
router.get('/:id', getActivity);

export default router;

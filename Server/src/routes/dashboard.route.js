import express from 'express';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {attachStaffContext, requirePermission} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';
import {getDashboardSummary} from '../controllers/dashboard.controller.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

router.get(
  '/summary',
  requirePermission(PERMISSIONS.DASHBOARD_READ),
  getDashboardSummary,
);

export default router;

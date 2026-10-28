import express from 'express';
import {
  createCompany,
  getMyCompanies,
  switchActiveCompany,
  updateCompany,
} from '../controllers/company.controller.js';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {
  attachStaffContext,
  requirePermission,
  requireAnyPermission,
} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

router.post('/', requirePermission(PERMISSIONS.COMPANY_MANAGE), createCompany);
// List/switch is operational context — any staff with dashboard or company.read
router.get(
  '/',
  requireAnyPermission(PERMISSIONS.COMPANY_READ, PERMISSIONS.DASHBOARD_READ),
  getMyCompanies,
);
router.patch(
  '/switch',
  requireAnyPermission(PERMISSIONS.COMPANY_READ, PERMISSIONS.DASHBOARD_READ),
  switchActiveCompany,
);
router.patch('/:id', requirePermission(PERMISSIONS.COMPANY_MANAGE), updateCompany);

export default router;

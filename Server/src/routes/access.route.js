import express from 'express';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {
  attachStaffContext,
  requireAnyPermission,
  requirePermission,
} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';
import {
  listPermissionCatalog,
  listRoles,
  getRoleById,
  updateRole,
  listStaff,
  assignStaffRole,
  createStaff,
  updateStaff,
  deleteStaff,
  setStaffPin,
  updateStaffPin,
  clearStaffPin,
  viewStaffPin,
  verifyStaffPin,
} from '../controllers/access.controller.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

router.get(
  '/permissions',
  requirePermission(PERMISSIONS.ACCESS_READ),
  listPermissionCatalog,
);

router.get('/roles', requirePermission(PERMISSIONS.ACCESS_READ), listRoles);
router.get('/roles/:id', requirePermission(PERMISSIONS.ACCESS_READ), getRoleById);
router.patch('/roles/:id', requirePermission(PERMISSIONS.ACCESS_MANAGE), updateRole);

router.get(
  '/staff',
  requireAnyPermission(
    PERMISSIONS.ACCESS_READ,
    PERMISSIONS.ACCESS_MANAGE,
    PERMISSIONS.DASHBOARD_READ,
    PERMISSIONS.INVOICE_READ,
    PERMISSIONS.INVOICE_CREATE,
    PERMISSIONS.EXPENSE_READ,
    PERMISSIONS.EXPENSE_CREATE,
  ),
  listStaff,
);
router.post('/staff', requirePermission(PERMISSIONS.ACCESS_MANAGE), createStaff);

/** PIN verify — available to anyone who can create invoices/bills */
router.post(
  '/staff/verify-pin',
  requireAnyPermission(
    PERMISSIONS.INVOICE_CREATE,
    PERMISSIONS.INVOICE_UPDATE,
    PERMISSIONS.ACCESS_MANAGE,
    PERMISSIONS.ACCESS_READ,
  ),
  verifyStaffPin,
);

router.patch(
  '/staff/:id/role',
  requirePermission(PERMISSIONS.ACCESS_MANAGE),
  assignStaffRole,
);
router.get(
  '/staff/:id/pin',
  requirePermission(PERMISSIONS.ACCESS_MANAGE),
  viewStaffPin,
);
router.post(
  '/staff/:id/pin',
  requirePermission(PERMISSIONS.ACCESS_MANAGE),
  setStaffPin,
);
router.patch(
  '/staff/:id/pin',
  requirePermission(PERMISSIONS.ACCESS_MANAGE),
  updateStaffPin,
);
router.delete(
  '/staff/:id/pin',
  requirePermission(PERMISSIONS.ACCESS_MANAGE),
  clearStaffPin,
);
router.patch(
  '/staff/:id',
  requirePermission(PERMISSIONS.ACCESS_MANAGE),
  updateStaff,
);
router.delete(
  '/staff/:id',
  requirePermission(PERMISSIONS.ACCESS_MANAGE),
  deleteStaff,
);

export default router;

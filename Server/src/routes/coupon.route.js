import express from 'express';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {
  attachStaffContext,
  requirePermission,
  requireAnyPermission,
} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';
import {
  activateCoupon,
  createCoupon,
  deactivateCoupon,
  deleteCoupon,
  getCoupons,
  updateCoupon,
  validateCoupon,
} from '../controllers/coupon.controller.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

router.post('/', requirePermission(PERMISSIONS.COUPON_MANAGE), createCoupon);
router.get('/', requirePermission(PERMISSIONS.COUPON_READ), getCoupons);
// Checkout helpers — cashiers may validate without coupon.manage
router.post(
  '/validate',
  requireAnyPermission(
    PERMISSIONS.COUPON_READ,
    PERMISSIONS.COUPON_MANAGE,
    PERMISSIONS.INVOICE_CREATE,
    PERMISSIONS.SUBSCRIPTION_CREATE,
  ),
  validateCoupon,
);
router.patch('/:id', requirePermission(PERMISSIONS.COUPON_MANAGE), updateCoupon);
router.patch('/:id/activate', requirePermission(PERMISSIONS.COUPON_MANAGE), activateCoupon);
router.patch('/:id/deactivate', requirePermission(PERMISSIONS.COUPON_MANAGE), deactivateCoupon);
router.delete('/:id', requirePermission(PERMISSIONS.COUPON_MANAGE), deleteCoupon);

export default router;

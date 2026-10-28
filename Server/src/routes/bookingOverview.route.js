import express from 'express';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {
  attachStaffContext,
  requireAnyPermission,
  requirePermission,
} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';
import {
  cancelOverviewBooking,
  getBookingOverview,
  getPaymentSettings,
  updateOverviewRefund,
  updatePaymentSettings,
} from '../controllers/bookingOverview.controller.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

const canView = requireAnyPermission(
  PERMISSIONS.SPACE_BOOKING_READ,
  PERMISSIONS.INVOICE_READ,
);

router.get('/payment-settings', canView, getPaymentSettings);
router.put(
  '/payment-settings',
  requirePermission(PERMISSIONS.SPACE_BOOKING_UPDATE),
  updatePaymentSettings,
);
router.get('/', canView, getBookingOverview);
router.post(
  '/:kind/:id/cancel',
  requirePermission(PERMISSIONS.SPACE_BOOKING_UPDATE),
  cancelOverviewBooking,
);
router.post(
  '/:kind/:id/refund',
  requirePermission(PERMISSIONS.SPACE_BOOKING_UPDATE),
  updateOverviewRefund,
);

export default router;

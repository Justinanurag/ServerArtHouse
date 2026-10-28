import express from 'express';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {
  attachStaffContext,
  requireAnyPermission,
  requirePermission,
} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';
import {
  createSpaceBooking,
  getSpaceBookings,
  getSpaceBookingAvailability,
  getSpaceBookingById,
  updateSpaceBooking,
  deleteSpaceBooking,
} from '../controllers/spaceBooking.controller.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

router.get(
  '/',
  requirePermission(PERMISSIONS.SPACE_BOOKING_READ),
  getSpaceBookings,
);
router.get(
  '/availability',
  requireAnyPermission(
    PERMISSIONS.SPACE_BOOKING_READ,
    PERMISSIONS.SPACE_BOOKING_CREATE,
    PERMISSIONS.SPACE_BOOKING_UPDATE,
  ),
  getSpaceBookingAvailability,
);
router.get(
  '/:id',
  requirePermission(PERMISSIONS.SPACE_BOOKING_READ),
  getSpaceBookingById,
);
router.post(
  '/',
  requirePermission(PERMISSIONS.SPACE_BOOKING_CREATE),
  createSpaceBooking,
);
router.put(
  '/:id',
  requirePermission(PERMISSIONS.SPACE_BOOKING_UPDATE),
  updateSpaceBooking,
);
router.patch(
  '/:id',
  requirePermission(PERMISSIONS.SPACE_BOOKING_UPDATE),
  updateSpaceBooking,
);
router.delete(
  '/:id',
  requirePermission(PERMISSIONS.SPACE_BOOKING_DELETE),
  deleteSpaceBooking,
);

export default router;

import express from 'express';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {
  attachStaffContext,
  requireAnyPermission,
  requirePermission,
} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';
import {
  createAllBooking,
  deleteAllBooking,
  getAllBookings,
  updateAllBooking,
} from '../controllers/allbooking.controller.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

router.get(
  '/',
  requireAnyPermission(PERMISSIONS.SPACE_BOOKING_READ, PERMISSIONS.INVOICE_READ),
  getAllBookings,
);
router.post('/', requirePermission(PERMISSIONS.SPACE_BOOKING_CREATE), createAllBooking);
router.patch('/:id', requirePermission(PERMISSIONS.SPACE_BOOKING_UPDATE), updateAllBooking);
router.delete('/:id', requirePermission(PERMISSIONS.SPACE_BOOKING_DELETE), deleteAllBooking);

export default router;

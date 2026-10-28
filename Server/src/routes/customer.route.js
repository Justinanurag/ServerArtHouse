import express from 'express';
import {
  createCustomer,
  getCustomers,
  getCustomerById,
  uploadCustomerImage,
  deleteCustomer,
  editCustomer,
  importCustomers,
  checkCustomerPhone,
} from '../controllers/customer.controller.js';
import {getCustomer360} from '../controllers/customer360.controller.js';
import {
  createMembershipOrder,
  verifyMembershipPayment,
} from '../controllers/razorpay.controller.js';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {attachStaffContext, requirePermission, requireAnyPermission} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

router.post(
  '/',
  requirePermission(PERMISSIONS.CUSTOMER_CREATE),
  uploadCustomerImage.single('profileImage'),
  createCustomer,
);
router.post(
  '/import',
  requirePermission(PERMISSIONS.CUSTOMER_CREATE),
  importCustomers,
);
router.get('/', requirePermission(PERMISSIONS.CUSTOMER_READ), getCustomers);
router.get(
  '/check-phone',
  requireAnyPermission(PERMISSIONS.CUSTOMER_READ, PERMISSIONS.CUSTOMER_CREATE),
  checkCustomerPhone,
);
router.get(
  '/:id/360',
  requirePermission(PERMISSIONS.CUSTOMER_READ),
  getCustomer360,
);
router.get(
  '/:id',
  requirePermission(PERMISSIONS.CUSTOMER_READ),
  getCustomerById,
);
router.post(
  '/check-phone',
  requireAnyPermission(PERMISSIONS.CUSTOMER_READ, PERMISSIONS.CUSTOMER_CREATE),
  checkCustomerPhone,
);
router.patch(
  '/:id',
  requirePermission(PERMISSIONS.CUSTOMER_UPDATE),
  uploadCustomerImage.single('profileImage'),
  editCustomer,
);
router.delete('/:id', requirePermission(PERMISSIONS.CUSTOMER_DELETE), deleteCustomer);

// ── Razorpay membership purchase ─────────────────────────────────────────────
router.post(
  '/:customerId/membership/razorpay-order',
  requirePermission(PERMISSIONS.SUBSCRIPTION_CREATE),
  createMembershipOrder,
);
router.post(
  '/:customerId/membership/razorpay-verify',
  requirePermission(PERMISSIONS.SUBSCRIPTION_CREATE),
  verifyMembershipPayment,
);

export default router;

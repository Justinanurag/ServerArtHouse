import express from 'express';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {attachStaffContext, requirePermission} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';
import {
  bulkCreateSubscriptions,
  createSubscription,
  deleteSubscription,
  getSubscriptionById,
  getSubscriptions,
  sendMembershipRenewalReminder,
  updateSubscription,
} from '../controllers/subscription.controller.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

router.get('/', requirePermission(PERMISSIONS.SUBSCRIPTION_READ), getSubscriptions);
// Static path before /:id
router.post(
  '/bulk',
  requirePermission(PERMISSIONS.SUBSCRIPTION_BULK_CREATE),
  bulkCreateSubscriptions,
);
router.post(
  '/:id/whatsapp-renewal',
  requirePermission(PERMISSIONS.SUBSCRIPTION_UPDATE),
  sendMembershipRenewalReminder,
);
router.get('/:id', requirePermission(PERMISSIONS.SUBSCRIPTION_READ), getSubscriptionById);
router.post('/', requirePermission(PERMISSIONS.SUBSCRIPTION_CREATE), createSubscription);
router.patch('/:id', requirePermission(PERMISSIONS.SUBSCRIPTION_UPDATE), updateSubscription);
router.delete('/:id', requirePermission(PERMISSIONS.SUBSCRIPTION_DELETE), deleteSubscription);

export default router;

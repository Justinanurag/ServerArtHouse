import express from 'express';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {
  attachStaffContext,
  requirePermission,
  requireAnyPermission,
} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';
import {
  getAffiliateSettings,
  updateAffiliateSettings,
  getAffiliateOverview,
  getAffiliateLeaderboard,
  getAffiliateStats,
  getWalletSummary,
  getAffiliatesList,
  getAffiliateById,
  getPayoutsList,
  createManualPayout,
  updatePayoutStatus,
  validateReferralDiscount,
} from '../controllers/affiliate.controller.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

// Checkout needs this for cashiers creating invoices/subscriptions
router.post(
  '/validate-referral-discount',
  requireAnyPermission(
    PERMISSIONS.INVOICE_CREATE,
    PERMISSIONS.INVOICE_READ,
    PERMISSIONS.SUBSCRIPTION_CREATE,
    PERMISSIONS.AFFILIATE_READ,
  ),
  validateReferralDiscount,
);

router.get('/settings', requirePermission(PERMISSIONS.AFFILIATE_READ), getAffiliateSettings);
router.put('/settings', requirePermission(PERMISSIONS.AFFILIATE_MANAGE), updateAffiliateSettings);
router.get('/overview', requirePermission(PERMISSIONS.AFFILIATE_READ), getAffiliateOverview);
router.get('/leaderboard', requirePermission(PERMISSIONS.AFFILIATE_READ), getAffiliateLeaderboard);
router.get('/stats', requirePermission(PERMISSIONS.AFFILIATE_READ), getAffiliateStats);
router.get('/wallet-summary', requirePermission(PERMISSIONS.AFFILIATE_READ), getWalletSummary);

router.get('/list', requirePermission(PERMISSIONS.AFFILIATE_READ), getAffiliatesList);
router.get('/affiliates/:id', requirePermission(PERMISSIONS.AFFILIATE_READ), getAffiliateById);

router.get('/payouts', requirePermission(PERMISSIONS.AFFILIATE_PAYOUT), getPayoutsList);
router.post('/payouts/manual', requirePermission(PERMISSIONS.AFFILIATE_PAYOUT), createManualPayout);
router.put('/payouts/:id', requirePermission(PERMISSIONS.AFFILIATE_PAYOUT), updatePayoutStatus);

export default router;

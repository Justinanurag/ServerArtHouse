import express from 'express';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {
  attachStaffContext,
  requirePermission,
  requireAnyPermission,
} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';
import {
  createGiftCard,
  deleteGiftCard,
  getGiftCardByCode,
  getGiftCardById,
  getGiftCards,
  redeemGiftCard,
  refundGiftCard,
  revokeGiftCardShare,
  shareGiftCard,
  updateGiftCard,
} from '../controllers/giftCard.controller.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

// Checkout helpers — cashiers may look up / redeem without gift_card.* permissions.
// Registered before '/:id' so "code" and "redeem" aren't parsed as ids.
router.get(
  '/code/:code',
  requireAnyPermission(
    PERMISSIONS.GIFT_CARD_READ,
    PERMISSIONS.INVOICE_CREATE,
    PERMISSIONS.SUBSCRIPTION_CREATE,
  ),
  getGiftCardByCode,
);
router.post(
  '/redeem',
  requireAnyPermission(
    PERMISSIONS.GIFT_CARD_UPDATE,
    PERMISSIONS.INVOICE_CREATE,
    PERMISSIONS.SUBSCRIPTION_CREATE,
  ),
  redeemGiftCard,
);
router.post(
  '/refund',
  requireAnyPermission(
    PERMISSIONS.GIFT_CARD_UPDATE,
    PERMISSIONS.INVOICE_CREATE,
    PERMISSIONS.SUBSCRIPTION_CREATE,
  ),
  refundGiftCard,
);

router.post('/', requirePermission(PERMISSIONS.GIFT_CARD_CREATE), createGiftCard);
router.get('/', requirePermission(PERMISSIONS.GIFT_CARD_READ), getGiftCards);
router.get('/:id', requirePermission(PERMISSIONS.GIFT_CARD_READ), getGiftCardById);
router.patch('/:id', requirePermission(PERMISSIONS.GIFT_CARD_UPDATE), updateGiftCard);
router.put('/:id', requirePermission(PERMISSIONS.GIFT_CARD_UPDATE), updateGiftCard);
router.delete('/:id', requirePermission(PERMISSIONS.GIFT_CARD_DELETE), deleteGiftCard);
router.post('/:id/share', requirePermission(PERMISSIONS.GIFT_CARD_UPDATE), shareGiftCard);
router.delete('/:id/share', requirePermission(PERMISSIONS.GIFT_CARD_UPDATE), revokeGiftCardShare);
export default router;

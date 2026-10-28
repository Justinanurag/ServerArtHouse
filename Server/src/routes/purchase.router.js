import express from 'express';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {attachStaffContext, requirePermission} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';
import {
  createPurchase,
  getPurchases,
  getPurchaseById,
  updatePurchase,
  deletePurchase,
  uploadPurchaseAttachments,
} from '../controllers/purchase.controller.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

router.post(
  '/',
  requirePermission(PERMISSIONS.PURCHASE_CREATE),
  uploadPurchaseAttachments.array('attachments'),
  createPurchase,
);
router.get('/', requirePermission(PERMISSIONS.PURCHASE_READ), getPurchases);
router.get('/:id', requirePermission(PERMISSIONS.PURCHASE_READ), getPurchaseById);
router.patch(
  '/:id',
  requirePermission(PERMISSIONS.PURCHASE_UPDATE),
  uploadPurchaseAttachments.array('attachments'),
  updatePurchase,
);
router.delete('/:id', requirePermission(PERMISSIONS.PURCHASE_DELETE), deletePurchase);

export default router;

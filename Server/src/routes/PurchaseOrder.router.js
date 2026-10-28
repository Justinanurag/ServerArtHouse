import express from 'express';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {attachStaffContext, requirePermission} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';
import {
  createPurchaseOrder,
  getPurchasesOrder,
  getPurchaseOrderById,
  updatePurchaseOrder,
  deletePurchaseOrder,
  uploadPurchaseOrderAttachments,
} from '../controllers/purchaseOrder.controller.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

router.post(
  '/',
  requirePermission(PERMISSIONS.PURCHASE_ORDER_CREATE),
  uploadPurchaseOrderAttachments.array('attachments'),
  createPurchaseOrder,
);
router.get('/', requirePermission(PERMISSIONS.PURCHASE_ORDER_READ), getPurchasesOrder);
router.get('/:id', requirePermission(PERMISSIONS.PURCHASE_ORDER_READ), getPurchaseOrderById);
router.patch(
  '/:id',
  requirePermission(PERMISSIONS.PURCHASE_ORDER_UPDATE),
  uploadPurchaseOrderAttachments.array('attachments'),
  updatePurchaseOrder,
);
router.delete(
  '/:id',
  requirePermission(PERMISSIONS.PURCHASE_ORDER_DELETE),
  deletePurchaseOrder,
);

export default router;

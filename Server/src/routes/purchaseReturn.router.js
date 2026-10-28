import express from 'express';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {attachStaffContext, requirePermission} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';
import {
  createPurchaseReturn,
  deletePurchaseReturn,
  getPurchaseReturnById,
  getPurchaseReturns,
  updatePurchaseReturn,
} from '../controllers/purchaseReturn.controller.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

// Catalog has debit_note.read / debit_note.create (no separate update/delete keys)
router.get('/', requirePermission(PERMISSIONS.DEBIT_NOTE_READ), getPurchaseReturns);
router.get('/:id', requirePermission(PERMISSIONS.DEBIT_NOTE_READ), getPurchaseReturnById);
router.post('/', requirePermission(PERMISSIONS.DEBIT_NOTE_CREATE), createPurchaseReturn);
router.patch('/:id', requirePermission(PERMISSIONS.DEBIT_NOTE_CREATE), updatePurchaseReturn);
router.delete('/:id', requirePermission(PERMISSIONS.DEBIT_NOTE_CREATE), deletePurchaseReturn);

export default router;

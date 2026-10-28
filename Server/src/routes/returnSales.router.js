import express from 'express';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {attachStaffContext, requirePermission} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';
import {
  createReturnSale,
  deleteReturnSale,
  getReturnSaleById,
  getReturnSales,
  updateReturnSale,
} from '../controllers/returnSales.controller.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

// Catalog has credit_note.read / credit_note.create (no separate update/delete keys)
router.get('/', requirePermission(PERMISSIONS.CREDIT_NOTE_READ), getReturnSales);
router.get('/:id', requirePermission(PERMISSIONS.CREDIT_NOTE_READ), getReturnSaleById);
router.post('/', requirePermission(PERMISSIONS.CREDIT_NOTE_CREATE), createReturnSale);
router.patch('/:id', requirePermission(PERMISSIONS.CREDIT_NOTE_CREATE), updateReturnSale);
router.delete('/:id', requirePermission(PERMISSIONS.CREDIT_NOTE_CREATE), deleteReturnSale);

export default router;

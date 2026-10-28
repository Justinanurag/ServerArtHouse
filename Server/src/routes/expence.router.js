import express from 'express';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {attachStaffContext, requirePermission} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';
import {
  addExpencesById,
  deleteExpencesById,
  getAllExpences,
  getExpencesById,
  recordExpencePayment,
  updateExpencesById,
  uploadExpenceReceipt,
} from '../controllers/expence.controller.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

router.get('/', requirePermission(PERMISSIONS.EXPENSE_READ), getAllExpences);
router.post('/:id/payments', requirePermission(PERMISSIONS.EXPENSE_UPDATE), recordExpencePayment);
router.get('/:id', requirePermission(PERMISSIONS.EXPENSE_READ), getExpencesById);
router.post('/', requirePermission(PERMISSIONS.EXPENSE_CREATE), uploadExpenceReceipt.single('receipt'), addExpencesById);
router.patch('/:id', requirePermission(PERMISSIONS.EXPENSE_UPDATE), uploadExpenceReceipt.single('receipt'), updateExpencesById);
router.delete('/:id', requirePermission(PERMISSIONS.EXPENSE_DELETE), deleteExpencesById);

export default router;
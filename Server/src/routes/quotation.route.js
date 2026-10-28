import express from 'express';
import {
  createQuotation,
  getQuotations,
  deleteQuotation,
  updateQuotation,
  updateQuotationStatus,
} from '../controllers/quotation.controller.js';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {attachStaffContext, requirePermission} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

router.post('/', requirePermission(PERMISSIONS.QUOTATION_CREATE), createQuotation);
router.get('/', requirePermission(PERMISSIONS.QUOTATION_READ), getQuotations);
router.delete('/:id', requirePermission(PERMISSIONS.QUOTATION_DELETE), deleteQuotation);
router.patch('/:id', requirePermission(PERMISSIONS.QUOTATION_UPDATE), updateQuotation);
router.patch('/:id/status', requirePermission(PERMISSIONS.QUOTATION_UPDATE), updateQuotationStatus);

export default router;

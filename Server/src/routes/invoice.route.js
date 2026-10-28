import express from 'express';
import {createInvoice, getInvoices, getInvoice, deleteInvoice, updateInvoice, cancelInvoice} from '../controllers/invoice.controller.js';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {attachStaffContext, requirePermission} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

router.post('/', requirePermission(PERMISSIONS.INVOICE_CREATE), createInvoice);
router.get('/', requirePermission(PERMISSIONS.INVOICE_READ), getInvoices);
router.get('/:id', requirePermission(PERMISSIONS.INVOICE_READ), getInvoice);
router.delete('/:id', requirePermission(PERMISSIONS.INVOICE_DELETE), deleteInvoice);
router.patch('/:id', requirePermission(PERMISSIONS.INVOICE_UPDATE), updateInvoice);
router.patch('/:id/cancel', requirePermission(PERMISSIONS.INVOICE_DELETE), cancelInvoice);

export default router;

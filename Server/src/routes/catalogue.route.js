import express from 'express';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {attachStaffContext, requireAnyPermission} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';
import {lookupCatalogueItems} from '../controllers/catalogue.controller.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

// Shared lookup for invoice / POS / quotation / purchase line pickers
router.get(
  '/lookup',
  requireAnyPermission(
    PERMISSIONS.PRODUCT_READ,
    PERMISSIONS.SERVICE_READ,
    PERMISSIONS.SPACE_READ,
    PERMISSIONS.FOOD_READ,
    PERMISSIONS.INVOICE_CREATE,
    PERMISSIONS.QUOTATION_CREATE,
    PERMISSIONS.PURCHASE_CREATE,
    PERMISSIONS.PURCHASE_ORDER_CREATE,
  ),
  lookupCatalogueItems,
);

export default router;

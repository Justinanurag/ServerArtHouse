import express from 'express';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {attachStaffContext, requirePermission} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';
import {getInventories, getInventoryTimeline} from '../controllers/Inventory.controller.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

router.get('/', requirePermission(PERMISSIONS.INVENTORY_READ), getInventories);
router.get(
  '/timeline',
  requirePermission(PERMISSIONS.INVENTORY_TIMELINE_READ),
  getInventoryTimeline,
);

export default router;

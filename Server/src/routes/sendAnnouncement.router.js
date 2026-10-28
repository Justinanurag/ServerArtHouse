import express from 'express';
import { authenticateUser } from '../middlewares/auth.middleware.js';
import { attachStaffContext, requirePermission } from '../middlewares/authorize.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
  createAnnouncement,
  listAnnouncements,
  listExhibitionLeads,
} from '../controllers/announcement.controller.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

router.post('/', requirePermission(PERMISSIONS.ANNOUNCEMENT_CREATE), createAnnouncement);
router.get('/', requirePermission(PERMISSIONS.ANNOUNCEMENT_READ), listAnnouncements);
router.get(
  '/exhibition-leads',
  requirePermission(PERMISSIONS.ANNOUNCEMENT_CREATE),
  listExhibitionLeads,
);

export default router;
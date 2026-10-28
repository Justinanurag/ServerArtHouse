import express from 'express';
import {
  upload,
  getServices,
  createService,
  updateService,
  deleteService,
} from '../controllers/service.controller.js';
import { authenticateUser } from '../middlewares/auth.middleware.js';
import {
  attachStaffContext,
  requirePermission,
} from '../middlewares/authorize.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

router.get('/', requirePermission(PERMISSIONS.SERVICE_READ), getServices);
router.post(
  '/',
  requirePermission(PERMISSIONS.SERVICE_CREATE),
  upload.array('images', 10),
  createService,
);
router.patch(
  '/:id',
  requirePermission(PERMISSIONS.SERVICE_UPDATE),
  upload.array('images', 10),
  updateService,
);
router.delete(
  '/:id',
  requirePermission(PERMISSIONS.SERVICE_DELETE),
  deleteService,
);

export default router;

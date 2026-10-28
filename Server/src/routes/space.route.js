import express from 'express';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {attachStaffContext, requirePermission} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';
import {
  createSpace,
  getSpaces,
  getSpaceById,
  updateSpace,
  deleteSpace,
  uploadSpaceImage,
} from '../controllers/space.controller.js';

const router = express.Router();

// Catalogue read. Customer app lists Exclusive / Coworking without a staff session.
router.get('/', getSpaces);

router.use(authenticateUser, attachStaffContext);

router.get('/:id', requirePermission(PERMISSIONS.SPACE_READ), getSpaceById);
router.post(
  '/',
  requirePermission(PERMISSIONS.SPACE_CREATE),
  uploadSpaceImage.single('image'),
  createSpace,
);
router.put(
  '/:id',
  requirePermission(PERMISSIONS.SPACE_UPDATE),
  uploadSpaceImage.single('image'),
  updateSpace,
);
router.patch(
  '/:id',
  requirePermission(PERMISSIONS.SPACE_UPDATE),
  uploadSpaceImage.single('image'),
  updateSpace,
);
router.delete('/:id', requirePermission(PERMISSIONS.SPACE_DELETE), deleteSpace);

export default router;

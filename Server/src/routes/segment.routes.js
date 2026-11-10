import express from 'express';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {attachStaffContext, requireAnyPermission} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';
import {
  createSegments,
  deleteSegments,
  getSegmentsById,
  getSegments,
  updateSegments,
} from '../controllers/segments.controller.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

router.get('/',getSegments);
router.get('/:id', getSegmentsById);
const canManageSegments = requireAnyPermission(
  PERMISSIONS.SEGMENT_CREATE,
  PERMISSIONS.CATEGORY_MANAGE,
  PERMISSIONS.PRODUCT_CREATE,
);

router.post('/', canManageSegments, createSegments);
router.patch('/:id', canManageSegments, updateSegments);
router.delete('/:id', canManageSegments, deleteSegments);

export default router;

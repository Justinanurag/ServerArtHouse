import express from 'express';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {attachStaffContext, requirePermission} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';
import {
  createMembership,
  getMemberships,
  updateMembership,
  deleteMembership,
} from '../controllers/membership.controller.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

router.post('/', requirePermission(PERMISSIONS.MEMBERSHIP_PLAN_MANAGE), createMembership);
router.get('/', requirePermission(PERMISSIONS.MEMBERSHIP_PLAN_READ), getMemberships);
router.patch('/:id', requirePermission(PERMISSIONS.MEMBERSHIP_PLAN_MANAGE), updateMembership);
router.delete('/:id', requirePermission(PERMISSIONS.MEMBERSHIP_PLAN_MANAGE), deleteMembership);

export default router;

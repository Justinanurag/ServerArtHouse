import express from 'express';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {
  attachStaffContext,
  requireAnyPermission,
} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';
import {
  createHapApplication,
  deleteHapApplication,
  getHapApplication,
  listHapApplications,
  updateHapApplication,
} from '../controllers/hapApplication.controller.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

const read = requireAnyPermission(
  PERMISSIONS.AFFILIATE_READ,
  PERMISSIONS.CUSTOMER_READ,
  PERMISSIONS.CSP_READ,
);
const write = requireAnyPermission(
  PERMISSIONS.AFFILIATE_MANAGE,
  PERMISSIONS.CUSTOMER_UPDATE,
  PERMISSIONS.CSP_WRITE,
);

router.get('/applications', read, listHapApplications);
router.get('/applications/:id', read, getHapApplication);
router.post('/applications', write, createHapApplication);
router.patch('/applications/:id', write, updateHapApplication);
router.delete('/applications/:id', write, deleteHapApplication);

export default router;

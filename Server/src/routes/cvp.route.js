import express from 'express';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {attachStaffContext, requireAnyPermission} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';
import {
  createCvpApplication,
  deleteCvpApplication,
  getCvpApplication,
  listCvpApplications,
  updateCvpApplication,
  uploadCvpPhoto,
} from '../controllers/cvpApplication.controller.js';

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

router.get('/', read, listCvpApplications);
router.get('/:id', read, getCvpApplication);
router.post('/', write, uploadCvpPhoto.single('photo'), createCvpApplication);
router.patch('/:id', write, uploadCvpPhoto.single('photo'), updateCvpApplication);
router.delete('/:id', write, deleteCvpApplication);

export default router;

import express from 'express';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {attachStaffContext, requirePermission} from '../middlewares/authorize.middleware.js';
import {getActivity} from '../controllers/activity.controller.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

router.get(
  '/activity',
  getActivity
);

export default router;
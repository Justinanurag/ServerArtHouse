import express from 'express';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {attachStaffContext} from '../middlewares/authorize.middleware.js';
import {
  insightsOverview,
  insightsVisitHistory,
  insightsVisitors,
} from '../controllers/insightsAnalytics.controller.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);
router.get('/insights', insightsOverview);
router.get('/visitors', insightsVisitors);
router.get('/visitors/:customerKey', insightsVisitHistory);

export default router;

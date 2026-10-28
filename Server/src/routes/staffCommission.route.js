import express from 'express';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {
  attachStaffContext,
  requirePermission,
} from '../middlewares/authorize.middleware.js';
import {getCommissionList, getCommission, postCommission,deleteCommission,updateCommission} from '../controllers/staff.CommissionController.js';
import {PERMISSIONS} from '../constants/permissions.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

router.get(
  '/commissionList',
  getCommissionList,
);

//Set commission  CRUD 
router.get('/get',getCommission);
router.post('/set',postCommission);
router.delete('/delete',deleteCommission);
router.patch('/update',updateCommission);
// requirePermission(PERMISSIONS.STAFF_COMMISSION_READ),
export default router;

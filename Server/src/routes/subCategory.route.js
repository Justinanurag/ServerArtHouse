import express from 'express';
import {
  getSubCategories,
  addSubCategories,
  updateSubCategories,
  deleteSubCategory,
} from '../controllers/subCategory.controller.js';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {
  attachStaffContext,
  requirePermission,
  requireAnyPermission,
} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

router.get(
  '/',
  requireAnyPermission(
    PERMISSIONS.CATEGORY_MANAGE,
    PERMISSIONS.PRODUCT_READ,
    PERMISSIONS.PRODUCT_CREATE,
    PERMISSIONS.SERVICE_READ,
    PERMISSIONS.SERVICE_CREATE,
    PERMISSIONS.FOOD_READ,
    PERMISSIONS.SPACE_READ,
  ),
  getSubCategories,
);
router.post('/', requirePermission(PERMISSIONS.CATEGORY_MANAGE), addSubCategories);
router.patch('/:id', requirePermission(PERMISSIONS.CATEGORY_MANAGE), updateSubCategories);
router.delete('/:id', requirePermission(PERMISSIONS.CATEGORY_MANAGE), deleteSubCategory);

export default router;

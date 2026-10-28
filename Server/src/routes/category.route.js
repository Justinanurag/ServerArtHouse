import express from 'express';
import {
  getCategories,
  addCategories,
  updateCategories,
  deleteCategory,
} from '../controllers/category.controller.js';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {
  attachStaffContext,
  requireAnyPermission,
} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

// Read categories when working catalogue / sales (no separate category.read key)
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
  getCategories,
);
router.post(
  '/',
  requireAnyPermission(
    PERMISSIONS.CATEGORY_MANAGE,
    PERMISSIONS.PRODUCT_CREATE,
    PERMISSIONS.SERVICE_CREATE,
  ),
  addCategories,
);
router.patch(
  '/',
  requireAnyPermission(
    PERMISSIONS.CATEGORY_MANAGE,
    PERMISSIONS.PRODUCT_UPDATE,
    PERMISSIONS.SERVICE_UPDATE,
  ),
  updateCategories,
);
router.delete(
  '/:id',
  requireAnyPermission(
    PERMISSIONS.CATEGORY_MANAGE,
    PERMISSIONS.PRODUCT_DELETE,
    PERMISSIONS.SERVICE_DELETE,
  ),
  deleteCategory,
);

export default router;

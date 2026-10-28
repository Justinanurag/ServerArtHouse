import express from 'express';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {attachStaffContext, requirePermission} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';
import {
  createFood,
  getFoods,
  getFoodById,
  updateFood,
  deleteFood,
  uploadFoodImage,
} from '../controllers/food.controller.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

router.get('/', requirePermission(PERMISSIONS.FOOD_READ), getFoods);
router.get('/:id', requirePermission(PERMISSIONS.FOOD_READ), getFoodById);
router.post(
  '/',
  requirePermission(PERMISSIONS.FOOD_CREATE),
  uploadFoodImage.single('image'),
  createFood,
);
router.put(
  '/:id',
  requirePermission(PERMISSIONS.FOOD_UPDATE),
  uploadFoodImage.single('image'),
  updateFood,
);
router.patch(
  '/:id',
  requirePermission(PERMISSIONS.FOOD_UPDATE),
  uploadFoodImage.single('image'),
  updateFood,
);
router.delete('/:id', requirePermission(PERMISSIONS.FOOD_DELETE), deleteFood);

export default router;

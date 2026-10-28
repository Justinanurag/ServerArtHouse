import express from 'express';
import {
  createProduct,
  getProducts,
  upload,
  deleteProduct,
  updateProduct,
  uploadBulkProducts,
  getProductsById,
} from '../controllers/product.controller.js';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {
  attachStaffContext,
  requireAnyPermission,
  requirePermission,
} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

/** Product catalogue routes always create/update products (never services). */
const forceProductType = (req, _res, next) => {
  req.forceItemType = 'product';
  if (req.body && typeof req.body === 'object') {
    req.body.type = 'product';
  }
  next();
};

router.get('/', requirePermission(PERMISSIONS.PRODUCT_READ), getProducts);
router.get('/:id', requirePermission(PERMISSIONS.PRODUCT_READ), getProductsById);
router.post(
  '/',
  requirePermission(PERMISSIONS.PRODUCT_CREATE),
  upload.array('images', 10),
  forceProductType,
  createProduct,
);
router.post(
  '/bulkUpload',
  requireAnyPermission(
    PERMISSIONS.PRODUCT_BULK_CREATE,
    PERMISSIONS.PRODUCT_CREATE,
  ),
  forceProductType,
  uploadBulkProducts,
);
router.patch(
  '/:id',
  requirePermission(PERMISSIONS.PRODUCT_UPDATE),
  upload.array('images', 10),
  forceProductType,
  updateProduct,
);
router.delete('/:id', requirePermission(PERMISSIONS.PRODUCT_DELETE), deleteProduct);

export default router;

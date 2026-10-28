import express from 'express';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {attachStaffContext, requirePermission} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';
import {
  bulkUpdateWallets,
  createWallet,
  deleteWallet,
  getWalletById,
  getWalletInstructions,
  getWallets,
  updateWallet,
} from '../controllers/wallet.controller.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

router.get('/', requirePermission(PERMISSIONS.WALLET_READ), getWallets);
router.get(
  '/instructions',
  requirePermission(PERMISSIONS.WALLET_READ),
  getWalletInstructions,
);
router.post('/', requirePermission(PERMISSIONS.WALLET_MANAGE), createWallet);
router.post('/:id', requirePermission(PERMISSIONS.WALLET_MANAGE), createWallet);
router.patch('/bulk', requirePermission(PERMISSIONS.WALLET_MANAGE), bulkUpdateWallets);
router.get('/:id', requirePermission(PERMISSIONS.WALLET_READ), getWalletById);
router.delete('/:id', requirePermission(PERMISSIONS.WALLET_MANAGE), deleteWallet);
router.patch('/:id', requirePermission(PERMISSIONS.WALLET_MANAGE), updateWallet);

export default router;

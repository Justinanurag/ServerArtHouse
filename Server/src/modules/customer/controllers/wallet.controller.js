import {asyncHandler} from '../utils/asyncHandler.js';
import {sendSuccess} from '../utils/response.js';
import * as walletService from '../services/wallet.service.js';

export const getWalletDashboard = asyncHandler(async (req, res) => {
  const data = await walletService.getWalletDashboard(
    req.customer._id,
    process.env.CUSTOMER_APP_URL,
  );
  return sendSuccess(res, {
    message: 'Wallet details loaded',
    data,
  });
});

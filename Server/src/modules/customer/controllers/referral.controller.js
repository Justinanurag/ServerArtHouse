import {asyncHandler} from '../utils/asyncHandler.js';
import {sendSuccess} from '../utils/response.js';
import * as referralService from '../services/referral.service.js';

export const getReferralDashboard = asyncHandler(async (req, res) => {
  const data = await referralService.getReferralDashboard(
    req.customer._id,
    process.env.CUSTOMER_APP_URL,
  );
  return sendSuccess(res, {
    message: 'Referral details loaded',
    data,
  });
});

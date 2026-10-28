import {asyncHandler} from '../utils/asyncHandler.js';
import {sendSuccess} from '../utils/response.js';
import * as couponService from '../services/coupon.service.js';

export const validateCoupon = asyncHandler(async (req, res) => {
  const {code, membershipType} = req.body ?? {};
  const data = await couponService.validateMembershipCoupon({
    code,
    membershipType,
    customerPhone: req.customer?.mobile,
  });

  return sendSuccess(res, {
    message: 'Coupon is valid',
    data,
  });
});

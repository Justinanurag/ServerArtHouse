import {
  validateCouponForOrder,
} from '../../../controllers/coupon.controller.js';
import {getMembershipOrderAmount} from '../constants/membershipPlans.js';

/**
 * Validate an admin-created coupon against a membership plan price.
 */
export const validateMembershipCoupon = async ({
  code,
  membershipType,
  customerPhone,
}) => {
  const orderAmount = await getMembershipOrderAmount(membershipType);
  if (orderAmount == null) {
    const error = new Error('Select a valid membership plan');
    error.status = 400;
    throw error;
  }

  const result = await validateCouponForOrder({
    code,
    orderAmount,
    customerPhone,
    applicableContext: 'membership',
  });

  if (!result.ok) {
    const error = new Error(result.message || 'Invalid coupon');
    error.status = 400;
    throw error;
  }

  const discountAmount = Math.round(Number(result.discountAmount) * 100) / 100;
  const payableAmount = Math.max(0, Math.round((orderAmount - discountAmount) * 100) / 100);

  return {
    code: result.coupon.code,
    title: result.coupon.title,
    discountType: result.coupon.discountType,
    discountValue: result.coupon.discountValue,
    orderAmount,
    discountAmount,
    payableAmount,
  };
};

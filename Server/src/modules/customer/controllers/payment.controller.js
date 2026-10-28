import {asyncHandler} from '../utils/asyncHandler.js';
import {sendSuccess} from '../utils/response.js';
import * as paymentService from '../services/payment.service.js';

export const initiateRazorpayPayment = asyncHandler(async (req, res) => {
  const data = await paymentService.initiateRazorpayMembershipPayment(
    req.customer._id,
    req.body,
  );
  return sendSuccess(res, {
    message:
      data.mode === 'free'
        ? 'Membership activated (no payment due)'
        : 'Razorpay order created',
    data,
  });
});

export const verifyRazorpayPayment = asyncHandler(async (req, res) => {
  const data = await paymentService.verifyRazorpayMembershipPayment(
    req.customer._id,
    req.body,
  );
  return sendSuccess(res, {
    message: data.alreadyActivated
      ? 'Membership already active'
      : 'Payment verified and membership activated',
    data,
  });
});

export const paymentStatus = asyncHandler(async (req, res) => {
  const data = await paymentService.getPaymentStatus(
    req.customer._id,
    req.params.txnid,
  );
  return sendSuccess(res, {
    message: 'Payment status fetched',
    data,
  });
});

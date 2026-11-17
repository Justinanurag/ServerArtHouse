import {asyncHandler} from '../utils/asyncHandler.js';
import {sendSuccess} from '../utils/response.js';
import {
  quoteCustomerSpaceBooking,
  startCustomerSpaceCheckout,
  verifyCustomerSpaceCheckout,
} from '../services/spaceCheckout.service.js';

const sendError = (res, error) => {
  const status = Number(error?.status) || 500;
  return res.status(status).json({
    success: false,
    message: error?.message || 'Could not complete the booking.',
  });
};

export const quoteSpaceCheckout = asyncHandler(async (req, res) => {
  try {
    const quote = await quoteCustomerSpaceBooking(req.customer, req.body);
    return sendSuccess(res, {message: 'Booking quote ready', data: quote});
  } catch (error) {
    return sendError(res, error);
  }
});

export const startSpaceCheckout = asyncHandler(async (req, res) => {
  try {
    const data = await startCustomerSpaceCheckout(req.customer, req.body);
    return sendSuccess(res, {
      message: data.mode === 'free' ? 'Booking confirmed' : 'Payment order created',
      data,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

export const verifySpaceCheckout = asyncHandler(async (req, res) => {
  try {
    const data = await verifyCustomerSpaceCheckout(req.customer, req.body);
    return sendSuccess(res, {
      message: data.alreadyConfirmed ? 'Booking already confirmed' : 'Booking confirmed',
      data,
    });
  } catch (error) {
    return sendError(res, error);
  }
});

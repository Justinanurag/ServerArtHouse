import {asyncHandler} from '../utils/asyncHandler.js';
import {sendSuccess} from '../utils/response.js';
import {
  listMyCoworkingBookings,
  quoteCoworkingBooking,
  startCoworkingCheckout,
  verifyCoworkingCheckout,
} from '../services/coworkingCheckout.service.js';

const sendError = (res, error) =>
  res.status(Number(error?.status) || 500).json({
    success: false,
    message: error?.message || 'Could not complete the coworking booking.',
  });

export const quoteCoworking = asyncHandler(async (req, res) => {
  try {
    const quote = await quoteCoworkingBooking(req.customer, req.body);
    return sendSuccess(res, {message: 'Coworking quote ready', data: quote});
  } catch (error) {
    return sendError(res, error);
  }
});

export const startCoworking = asyncHandler(async (req, res) => {
  try {
    const data = await startCoworkingCheckout(req.customer, req.body);
    return sendSuccess(res, {message: data.mode === 'free' ? 'Booking confirmed' : 'Payment order created', data});
  } catch (error) {
    return sendError(res, error);
  }
});

export const verifyCoworking = asyncHandler(async (req, res) => {
  try {
    const data = await verifyCoworkingCheckout(req.customer, req.body);
    return sendSuccess(res, {message: 'Booking confirmed', data});
  } catch (error) {
    return sendError(res, error);
  }
});

export const myCoworkingBookings = asyncHandler(async (req, res) => {
  const bookings = await listMyCoworkingBookings(req.customer);
  return sendSuccess(res, {message: 'Bookings loaded', data: bookings});
});

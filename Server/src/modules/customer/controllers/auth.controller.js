import {asyncHandler} from '../utils/asyncHandler.js';
import {sendSuccess} from '../utils/response.js';
import * as authService from '../services/auth.service.js';

const getRequestMeta = req => ({
  ipAddress: req.ip || req.headers['x-forwarded-for'] || '',
  deviceInfo: {
    userAgent: req.headers['user-agent'] || '',
    ...(req.body?.deviceInfo || {}),
  },
});

export const signup = asyncHandler(async (req, res) => {
  const result = await authService.signupCustomer(
    res,
    req.body,
    getRequestMeta(req),
  );
  return sendSuccess(res, {
    status: 201,
    message: 'Signup successful',
    data: result.customer,
    token: result.token,
    refreshToken: result.refreshToken,
  });
});

export const login = asyncHandler(async (req, res) => {
  const result = await authService.loginWithPassword(
    res,
    req.body,
    getRequestMeta(req),
  );
  return sendSuccess(res, {
    message: 'Login Successful',
    data: result.customer,
    token: result.token,
    refreshToken: result.refreshToken,
  });
});

export const loginOtp = asyncHandler(async (req, res) => {
  const result = await authService.requestLoginOtp(req.body);
  return sendSuccess(res, {
    message: 'OTP sent successfully',
    data: result,
  });
});

export const verifyOtp = asyncHandler(async (req, res) => {
  const purpose = req.body.purpose || 'login';

  if (purpose === 'forgot-password') {
    const result = await authService.verifyForgotPasswordOtp(req.body);
    return sendSuccess(res, {
      message: 'OTP verified. You can now reset your password.',
      data: result,
    });
  }

  const result = await authService.verifyLoginOtp(
    res,
    req.body,
    getRequestMeta(req),
  );
  return sendSuccess(res, {
    message: 'OTP verified successfully',
    data: result.customer,
    token: result.token,
    refreshToken: result.refreshToken,
  });
});

export const resendOtp = asyncHandler(async (req, res) => {
  const result = await authService.resendOtp(req.body);
  return sendSuccess(res, {
    message: 'OTP resent successfully',
    data: result,
  });
});

export const forgotPassword = asyncHandler(async (req, res) => {
  const result = await authService.forgotPasswordRequest(req.body);
  return sendSuccess(res, {
    message: 'OTP sent for password reset',
    data: result,
  });
});

export const resetPassword = asyncHandler(async (req, res) => {
  const result = await authService.resetPassword(req.body);
  return sendSuccess(res, {
    message: 'Password reset successful. Please login again.',
    data: result.customer,
  });
});

export const refreshToken = asyncHandler(async (req, res) => {
  const raw =
    req.cookies?.customerRefreshToken ||
    req.body?.refreshToken ||
    req.headers['x-refresh-token'];

  const result = await authService.refreshCustomerSession(
    res,
    raw,
    getRequestMeta(req),
  );
  return sendSuccess(res, {
    message: 'Token refreshed successfully',
    data: result.customer,
    token: result.token,
    refreshToken: result.refreshToken,
  });
});

export const logout = asyncHandler(async (req, res) => {
  const raw =
    req.cookies?.customerRefreshToken ||
    req.body?.refreshToken ||
    req.headers['x-refresh-token'];
  await authService.logoutCustomer(res, raw);
  return sendSuccess(res, {
    message: 'Logged out successfully',
  });
});

export const me = asyncHandler(async (req, res) => {
  const customer = await authService.getCustomerProfile(req.customer._id);
  return sendSuccess(res, {
    message: 'Customer profile fetched',
    data: customer,
  });
});

export const updateProfile = asyncHandler(async (req, res) => {
  const customer = await authService.updateCustomerProfile(
    req.customer._id,
    req.body,
  );
  return sendSuccess(res, {
    message: 'Profile updated successfully',
    data: customer,
  });
});

export const deleteProfile = asyncHandler(async (req, res) => {
  await authService.deleteCustomerAccount(res, req.customer._id);
  return sendSuccess(res, {
    message: 'Profile deleted successfully',
  });
});

export const activateMembership = asyncHandler(async (req, res) => {
  const result = await authService.activateMembership(req.customer._id, req.body);
  return sendSuccess(res, {
    message: result.whatsapp?.delivered
      ? 'Membership activated successfully. WhatsApp confirmation sent.'
      : 'Membership activated successfully',
    data: result.customer,
  });
});

import express from 'express';
import {
  healthCheck,
  login,
  logout,
  register,
  requestOtp,
  verifyOtp,
  updateMe,
  updateUser,
  forgotPassword,
  requestEmailOtp,
  checkPhone
} from '../controllers/auth.controller.js';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {
  authLoginLimiter,
  authRegisterLimiter,
  authOtpLimiter,
  authPasswordResetLimiter,
} from '../middlewares/authRateLimit.middleware.js';

const router = express.Router();

router.get('/check', healthCheck);

// Public auth — rate limited
router.post('/register', authRegisterLimiter, register);
router.post('/login', authLoginLimiter, login);
router.post('/logout', logout);
router.post('/request-otp', authOtpLimiter, requestOtp);
router.post('/request-email-otp', authOtpLimiter, requestEmailOtp);
router.post('/verify-otp', authOtpLimiter, verifyOtp);
router.patch('/forgot-password', authPasswordResetLimiter, forgotPassword);
router.post('/checkPhone', authPasswordResetLimiter, checkPhone);
router.get('/checkPhone', authPasswordResetLimiter, checkPhone);

// Authenticated profile updates (Step 11 — no more open PATCH /:mobile)
router.patch('/me', authenticateUser, updateMe);
// Legacy path kept but now requires auth + ownership check
router.patch('/:mobile', authenticateUser, updateUser);

export default router;

import rateLimit from 'express-rate-limit';

/**
 * Step 11 — Auth rate limiters (brute-force / OTP abuse protection).
 */

const jsonMessage = message => ({
  success: false,
  message,
});

export const authLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: jsonMessage('Too many login attempts. Try again later.'),
});

export const authRegisterLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: jsonMessage('Too many registration attempts. Try again later.'),
});

export const authOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: jsonMessage('Too many OTP requests. Try again later.'),
});

export const authPasswordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: jsonMessage('Too many password reset attempts. Try again later.'),
});

/**
 * Customer Auth Module
 * Mounted at: /api/customer/*
 * Admin CRM customers remain at: /customer/*
 *
 * Endpoints:
 * POST /signup
 * POST /login
 * POST /login/otp
 * POST /verify-otp
 * POST /resend-otp
 * POST /forgot-password
 * POST /reset-password
 * POST /refresh-token
 * POST /logout
 * GET  /me
 * PUT  /profile
 */
export {default as customerAuthRoutes} from './routes/auth.routes.js';

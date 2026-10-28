import express from 'express';
import {
  signup,
  login,
  loginOtp,
  verifyOtp,
  resendOtp,
  forgotPassword,
  resetPassword,
  refreshToken,
  logout,
  me,
  updateProfile,
  deleteProfile,
  activateMembership,
} from '../controllers/auth.controller.js';
import {validateCoupon} from '../controllers/coupon.controller.js';
import {
  initiateRazorpayPayment,
  verifyRazorpayPayment,
  paymentStatus,
} from '../controllers/payment.controller.js';
import {getReferralDashboard} from '../controllers/referral.controller.js';
import {getWalletDashboard} from '../controllers/wallet.controller.js';
import {getCustomerMembershipPlans} from '../controllers/membership.controller.js';
import {
  getCustomerSpaceById,
  getSpaces,
} from '../../../controllers/space.controller.js';
import {getCustomerSpaceAvailability} from '../../../controllers/spaceBooking.controller.js';
import {
  getCustomerProductById,
  getCustomerProducts,
  upload,
} from '../../../controllers/product.controller.js';
import {
  getMyActivity,
  getMyActivityDetail,
  getMyActivityInsights,
} from '../controllers/activity.controller.js';
import {
  applyCsp,
  getMyCspApplication,
} from '../../../controllers/cspApplication.controller.js';
import {
  createMyCspProduct,
  deleteMyCspProduct,
  listMyCspProducts,
  updateMyCspProduct,
} from '../../../controllers/cspProduct.controller.js';
import {validateRequest} from '../middlewares/validateRequest.js';
import {
  authenticateCustomer,
  authorizeCustomer,
} from '../middlewares/authenticateCustomer.js';
import {
  customerAuthLimiter,
  customerOtpLimiter,
} from '../middlewares/rateLimit.js';
import {
  signupSchema,
  loginSchema,
  otpLoginSchema,
  verifyOtpSchema,
  resendOtpSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  updateProfileSchema,
  activateMembershipSchema,
  validateMembershipCouponSchema,
  initiatePaymentSchema,
} from '../validators/auth.validators.js';

const router = express.Router();

router.use(customerAuthLimiter);

/**
 * Customer Auth APIs — mounted at /api/customer
 * Intentionally separate from admin /customer CRUD routes.
 */
router.post('/signup', validateRequest(signupSchema), signup);
router.post('/login', validateRequest(loginSchema), login);
router.post(
  '/login/otp',
  customerOtpLimiter,
  validateRequest(otpLoginSchema),
  loginOtp,
);
router.post(
  '/verify-otp',
  customerOtpLimiter,
  validateRequest(verifyOtpSchema),
  verifyOtp,
);
router.post(
  '/resend-otp',
  customerOtpLimiter,
  validateRequest(resendOtpSchema),
  resendOtp,
);
router.post(
  '/forgot-password',
  customerOtpLimiter,
  validateRequest(forgotPasswordSchema),
  forgotPassword,
);
router.post(
  '/reset-password',
  validateRequest(resetPasswordSchema),
  resetPassword,
);
router.post('/refresh-token', refreshToken);
router.post('/logout', logout);

router.get('/membership/plans', getCustomerMembershipPlans);
router.get('/space', getSpaces);
router.get('/space/availability', getCustomerSpaceAvailability);
router.get('/space/:id', getCustomerSpaceById);
router.get('/product', getCustomerProducts);
router.get('/product/:id', getCustomerProductById);

router.get('/me', authenticateCustomer, authorizeCustomer('active'), me);
router.get(
  '/csp/application',
  authenticateCustomer,
  authorizeCustomer('active'),
  getMyCspApplication,
);
router.post(
  '/csp/apply',
  authenticateCustomer,
  authorizeCustomer('active'),
  applyCsp,
);
router.get(
  '/csp/products',
  authenticateCustomer,
  authorizeCustomer('active'),
  listMyCspProducts,
);
router.post(
  '/csp/products',
  authenticateCustomer,
  authorizeCustomer('active'),
  upload.single('image'),
  createMyCspProduct,
);
router.patch(
  '/csp/products/:id',
  authenticateCustomer,
  authorizeCustomer('active'),
  upload.single('image'),
  updateMyCspProduct,
);
router.delete(
  '/csp/products/:id',
  authenticateCustomer,
  authorizeCustomer('active'),
  deleteMyCspProduct,
);
router.get(
  '/referral',
  authenticateCustomer,
  authorizeCustomer('active'),
  getReferralDashboard,
);
router.get(
  '/wallet',
  authenticateCustomer,
  authorizeCustomer('active'),
  getWalletDashboard,
);
router.get(
  '/activity',
  authenticateCustomer,
  authorizeCustomer('active'),
  getMyActivity,
);
router.get(
  '/activity/insights',
  authenticateCustomer,
  authorizeCustomer('active'),
  getMyActivityInsights,
);
router.get(
  '/activity/:invoiceId',
  authenticateCustomer,
  authorizeCustomer('active'),
  getMyActivityDetail,
);
router.put(
  '/profile',
  authenticateCustomer,
  authorizeCustomer('active'),
  validateRequest(updateProfileSchema),
  updateProfile,
);
router.delete(
  '/profile',
  authenticateCustomer,
  authorizeCustomer('active'),
  deleteProfile,
);
router.post(
  '/coupon/validate',
  authenticateCustomer,
  authorizeCustomer('active'),
  validateRequest(validateMembershipCouponSchema),
  validateCoupon,
);

// ── Razorpay payment routes ───────────────────────────────────────────────────
router.post(
  '/payments/razorpay/initiate',
  authenticateCustomer,
  authorizeCustomer('active'),
  validateRequest(initiatePaymentSchema),
  initiateRazorpayPayment,
);
router.post(
  '/payments/razorpay/verify',
  authenticateCustomer,
  authorizeCustomer('active'),
  verifyRazorpayPayment,
);
router.get(
  '/payments/:txnid',
  authenticateCustomer,
  authorizeCustomer('active'),
  paymentStatus,
);
router.post(
  '/membership/activate',
  authenticateCustomer,
  authorizeCustomer('active'),
  validateRequest(activateMembershipSchema),
  activateMembership,
);

export default router;

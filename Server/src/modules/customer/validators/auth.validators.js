import {z} from 'zod';

const mobileSchema = z
  .string()
  .trim()
  .regex(/^(?:\+?91)?[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number');

const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password is too long');

const otpSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'OTP must be a 6-digit number');

export const signupSchema = z
  .object({
    name: z.string().trim().min(2, 'Name is required').max(80),
    mobile: mobileSchema,
    email: z
      .string()
      .trim()
      .email('Enter a valid email')
      .optional()
      .or(z.literal('')),
    password: passwordSchema,
    confirmPassword: z.string().optional(),
    countryCode: z.string().optional(),
    gender: z.enum(['male', 'female', 'other', '']).optional(),
    dob: z.union([z.string(), z.date(), z.null()]).optional(),
    acceptTerms: z.boolean().optional(),
    ref: z.string().trim().max(32).optional(),
  })
  .refine(
    data => !data.confirmPassword || data.password === data.confirmPassword,
    {message: 'Passwords do not match', path: ['confirmPassword']},
  );

export const loginSchema = z.object({
  identifier: z.string().trim().min(3, 'Email or mobile is required'),
  password: z.string().min(1, 'Password is required'),
  rememberMe: z.boolean().optional(),
});

export const otpLoginSchema = z.object({
  mobile: mobileSchema,
  countryCode: z.string().optional(),
});

export const verifyOtpSchema = z
  .object({
    mobile: mobileSchema.optional(),
    identifier: z.string().optional(),
    email: z.string().optional(),
    otp: otpSchema,
    name: z.string().optional(),
    countryCode: z.string().optional(),
    ref: z.string().trim().max(32).optional(),
    purpose: z
      .enum(['login', 'signup', 'forgot-password', 'verify-mobile', 'verify-email'])
      .optional(),
  })
  .refine(data => Boolean(data.mobile || data.identifier || data.email), {
    message: 'Mobile number or email is required',
    path: ['mobile'],
  });

export const resendOtpSchema = z
  .object({
    mobile: mobileSchema.optional(),
    email: z.string().email().optional(),
    identifier: z.string().optional(),
    purpose: z
      .enum(['login', 'signup', 'forgot-password', 'verify-mobile', 'verify-email'])
      .optional(),
  })
  .refine(data => Boolean(data.mobile || data.identifier || data.email), {
    message: 'Mobile number or email is required',
    path: ['mobile'],
  });

export const forgotPasswordSchema = z.object({
  identifier: z.string().trim().min(3, 'Email or mobile is required'),
});

export const resetPasswordSchema = z
  .object({
    identifier: z.string().trim().min(3, 'Email or mobile is required'),
    otp: otpSchema.optional(),
    resetToken: z.string().optional(),
    newPassword: passwordSchema,
    confirmPassword: z.string().optional(),
  })
  .refine(data => Boolean(data.otp || data.resetToken), {
    message: 'OTP or reset token is required',
    path: ['otp'],
  })
  .refine(
    data => !data.confirmPassword || data.newPassword === data.confirmPassword,
    {message: 'Passwords do not match', path: ['confirmPassword']},
  );

export const updateProfileSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  email: z.string().trim().email().optional().or(z.literal('')),
  gender: z.enum(['male', 'female', 'other', '']).optional(),
  dob: z.union([z.string(), z.date(), z.null()]).optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  pincode: z.string().optional(),
  profileImage: z.string().optional(),
  whatsappNumber: z.string().optional(),
  membershipType: z.string().trim().min(1).max(64).optional(),
  profileSetupCompleted: z.boolean().optional(),
  onboardingCompleted: z.boolean().optional(),
});

export const activateMembershipSchema = z.object({
  membershipType: z.string().trim().min(1).max(64),
  couponCode: z.string().trim().max(40).optional(),
});

export const validateMembershipCouponSchema = z.object({
  code: z.string().trim().min(1).max(40),
  membershipType: z.string().trim().min(1).max(64),
});

export const initiatePaymentSchema = z.object({
  membershipType: z.string().trim().min(1).max(64),
  couponCode: z.string().trim().max(40).optional(),
});

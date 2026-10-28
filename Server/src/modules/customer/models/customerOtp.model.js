import mongoose from 'mongoose';

const customerOtpSchema = new mongoose.Schema(
  {
    identifier: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    identifierType: {
      type: String,
      enum: ['mobile', 'email'],
      required: true,
    },
    purpose: {
      type: String,
      enum: ['login', 'signup', 'forgot-password', 'verify-mobile', 'verify-email'],
      required: true,
    },
    otpHash: {
      type: String,
      required: true,
    },
    attempts: {
      type: Number,
      default: 0,
    },
    maxAttempts: {
      type: Number,
      default: 5,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    verified: {
      type: Boolean,
      default: false,
    },
    meta: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {timestamps: true},
);

customerOtpSchema.index({expiresAt: 1}, {expireAfterSeconds: 0});
customerOtpSchema.index({identifier: 1, purpose: 1});

const CustomerOtp = mongoose.model('CustomerOtp', customerOtpSchema);

export default CustomerOtp;

import mongoose from 'mongoose';

const customerRefreshTokenSchema = new mongoose.Schema(
  {
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
      index: true,
    },
    tokenHash: {
      type: String,
      required: true,
      unique: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    replacedByTokenHash: {
      type: String,
      default: null,
    },
    deviceInfo: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    ipAddress: {
      type: String,
      default: '',
    },
  },
  {timestamps: true},
);

customerRefreshTokenSchema.index({expiresAt: 1}, {expireAfterSeconds: 0});

const CustomerRefreshToken = mongoose.model(
  'CustomerRefreshToken',
  customerRefreshTokenSchema,
);

export default CustomerRefreshToken;

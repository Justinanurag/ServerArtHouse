import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    m_staff_id: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    fullName: {
      type: String,
      trim: true,
      required: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    /** E.164 format, e.g. +91XXXXXXXXXX */
    phoneNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },
    /**
     * Staff billing PIN (bcrypt hash). Used to verify who physically bills,
     * independent of the logged-in user (createdBy).
     */
    pinHash: {
      type: String,
      default: null,
      select: false,
    },
    /**
     * AES-GCM encrypted PIN for admin "View PIN" on Access screen.
     * Verification still uses pinHash (bcrypt). Never returned in list APIs.
     */
    pinEncrypted: {
      type: String,
      default: null,
      select: false,
    },
    pinEnabled: {
      type: Boolean,
      default: false,
      index: true,
    },
    pinFailedAttempts: {
      type: Number,
      default: 0,
      select: false,
    },
    pinLockedUntil: {
      type: Date,
      default: null,
      select: false,
    },
    /**
     * Legacy coarse role string (kept for backward compatibility).
     * Prefer `roleId` + Role.permissions for real RBAC.
     */
    role: {
      type: String,
      enum: ['admin', 'user'],
      default: 'user',
      index: true,
    },
    /**
     * RBAC: reference to Role document that holds permission keys.
     * Null = no RBAC role assigned yet (fallback behavior defined in middleware later).
     */
    roleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Role',
      default: null,
      index: true,
    },
    /** Staff sales commission percent (e.g. 6 = 6% of attributed invoice grandTotal) */
    commissionRate: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    gstin: { type: String, trim: true },
    companyName: { type: String, trim: true },
    address: { type: String, trim: true },
    pincode: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    country: { type: String, trim: true },
    membershipType: { type: String, trim: true },
    adharNumber: { type: String, trim: true },
    dob: { type: String, trim: true },
    gender: { type: String, trim: true },
    whatsappNumber: { type: String, trim: true },
    AlternateMobile: { type: String, trim: true },
    companies: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
      },
    ],
    activeCompany: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Company',
    },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },

  {timestamps: true},
);

const User = mongoose.model('User', userSchema);
export default User;

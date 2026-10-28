import mongoose from "mongoose";
import {resolveTwoBuckets} from "../utils/walletBuckets.js";

const customerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    mobile: {
      type: String,
      required: true,
      trim: true,
      match: [/^[6-9]\d{9}$/, "Invalid mobile number"],
    },

    email: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },

    gstin: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
    },

    companyName: {
      type: String,
      default: "",
      trim: true,
    },

    address: {
      type: String,
      default: "",
      trim: true,
    },

    pincode: {
      type: String,
      default: "",
      trim: true,
    },

    city: {
      type: String,
      default: "",
      trim: true,
    },

    state: {
      type: String,
      default: "",
      trim: true,
    },

    country: {
      type: String,
      default: "India",
      trim: true,
    },

 
    /**
     * Membership plan key (planId from Membership collection).
     * Keep as free string — Manage Plans can add custom ids (e.g. lifetime).
     */
    membershipType: {
      type: String,
      trim: true,
      lowercase: true,
      default: "none",
    },
    membershipPlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Membership",
      default: null,
    },
    /** Priority of the customer's current (non-Junior) membership plan */
    priority: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Last membership purchase pricing (portal checkout)
    membershipPurchase: {
      orderAmount: { type: Number, default: null },
      discountAmount: { type: Number, default: 0 },
      paidAmount: { type: Number, default: null },
      couponCode: { type: String, default: null, uppercase: true, trim: true },
      purchasedAt: { type: Date, default: null },
      paymentOrderId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "PaymentOrder",
        default: null,
      },
      txnid: { type: String, default: null, trim: true },
    },

    // Coupon redemptions from membership (and future portal) checkouts
    couponUsages: [
      {
        code: { type: String, required: true, uppercase: true, trim: true },
        discountAmount: { type: Number, default: 0 },
        orderAmount: { type: Number, default: 0 },
        membershipType: { type: String, default: null },
        source: {
          type: String,
          enum: ["membership", "invoice", "other"],
          default: "membership",
        },
        usedAt: { type: Date, default: Date.now },
      },
    ],

    // Portal onboarding (default true so existing CRM customers skip)
    profileSetupCompleted: {
      type: Boolean,
      default: true,
    },
    onboardingCompleted: {
      type: Boolean,
      default: true,
    },
    accountCreatedWhatsAppSent: {
      type: Boolean,
      default: false,
    },
    welcomeBonusCredited: {
      type: Boolean,
      default: false,
    },

    // =========================
    // PERSONAL INFO
    // =========================
    adharNumber: {
      type: String,
      default: "",
      trim: true,
    },

    dob: {
      type: Date,
      default: null,
    },

    gender: {
      type: String,
      enum: ["male", "female", "other", ""],
      default: "",
    },

    whatsappNumber: {
      type: String,
      default: "",
      trim: true,
    },

    AlternateMobile: {
      type: String,
      default: "",
      trim: true,
    },

    // =========================
    // BANK DETAILS
    // =========================
    IFSCcode: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
    },

    bankName: {
      type: String,
      default: "",
      trim: true,
    },

    branchName: {
      type: String,
      default: "",
      trim: true,
    },

    accountNumber: {
      type: String,
      default: "",
      trim: true,
    },

    panNumber: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
    },

    accountHolderName: {
      type: String,
      default: "",
      trim: true,
    },

    UPIID: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },

    // =========================
    // PROFILE IMAGE
    // =========================
    profileImage: {
      type: String,
      default: "",
    },

    // =========================
    // WALLET (two types only)
    // =========================
    walletAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    closingBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Withdrawable: affiliate / referral / CSP eligible
    withdrawable: {
      type: Number,
      min: 0,
    },
    // Non-withdrawable: cashback + other restricted credits
    nonWithdrawable: {
      type: Number,
      min: 0,
    },
    // Alias of withdrawable
    affiliateBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Alias of nonWithdrawable
    cashbackBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    affiliateReserved: {
      type: Number,
      default: 0,
      min: 0,
    },

    // =========================
    // REFERRAL / AFFILIATE
    // =========================
    referralCode: {
      type: String,
      trim: true,
      uppercase: true,
      default: null,
      sparse: true,
      unique: true,
    },
    referredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      default: null,
      index: true,
    },
    referredAt: {
      type: Date,
      default: null,
    },
    inviteRewardCredited: {
      type: Boolean,
      default: false,
    },
    // Buyer can receive referral checkout discount only once per account
    referralDiscountUsed: {
      type: Boolean,
      default: false,
      index: true,
    },
    referralDiscountUsedAt: {
      type: Date,
      default: null,
    },
    referralDiscountSourceId: {
      type: String,
      default: null,
      trim: true,
    },

    // =========================
    // CUSTOMER AUTH (portal)
    // =========================
    // Portal login id. Omit when unset — do NOT default to null.
    // A unique sparse/partial index treats null as a real value and blocks inserts.
    customerId: {
      type: String,
      trim: true,
      default: undefined,
    },
    countryCode: {
      type: String,
      default: "+91",
      trim: true,
    },
    password: {
      type: String,
      select: false,
      default: null,
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    emailVerified: {
      type: Boolean,
      default: false,
    },
    mobileVerified: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: ["active", "inactive", "blocked"],
      default: "active",
    },
    rewardPoints: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastLogin: {
      type: Date,
      default: null,
    },
    deviceInfo: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    loginType: {
      type: String,
      enum: ["password", "otp", "both", ""],
      default: "",
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
      default: null,
    },

    // =========================
    // CREATED BY
    // =========================
    createdBy: {
      m_staff_id: { type: String, default: null },
      m_staff_name: { type: String, default: null },
      m_staff_email: { type: String, default: null },
    },
  },
  {
    timestamps: true,
  }
);

// =========================
// INDEXES (IMPORTANT)
// =========================
customerSchema.index({ name: 1 });
customerSchema.index({ mobile: 1 }, { unique: true });
// List endpoint sorts by newest first — compound matches sort + stable tiebreak
customerSchema.index({ createdAt: -1, _id: -1 });
customerSchema.index({ isDeleted: 1, createdAt: -1 });
// Only enforce uniqueness when a real portal customerId is present
customerSchema.index(
  { customerId: 1 },
  {
    unique: true,
    name: "customerId_unique_partial",
    partialFilterExpression: {
      customerId: { $type: "string", $gt: "" },
    },
  },
);
customerSchema.index(
  { email: 1 },
  {
    unique: true,
    partialFilterExpression: { email: { $type: "string", $gt: "" } },
  },
);

customerSchema.methods.toSafeObject = function toSafeObject() {
  const obj = this.toObject({ virtuals: true });
  delete obj.password;
  delete obj.__v;
  const buckets = resolveTwoBuckets(null, obj);
  obj.withdrawable = buckets.withdrawable;
  obj.nonWithdrawable = buckets.nonWithdrawable;
  obj.affiliateBalance = buckets.withdrawable;
  obj.cashbackBalance = buckets.nonWithdrawable;
  obj.walletAmount = buckets.total;
  obj.closingBalance = buckets.total;
  obj.walletBalance = buckets.total;
  return obj;
};

// =========================
// HOOKS
// =========================
customerSchema.pre("save", function (next) {
  if (!this.referralCode) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let code = "";
    for (let i = 0; i < 8; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    this.referralCode = `W${code}`;
  }
  next();
});

// =========================
// MODEL
// =========================
const Customer = mongoose.model("Customer", customerSchema);

export default Customer;
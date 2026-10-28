import mongoose from "mongoose";

const commissionLedgerSchema = new mongoose.Schema(
  {
    affiliateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },
    purchaserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      default: null, // Null for milestone bonuses
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId, // Can refer to different order types, so no ref
      default: null,
    },
    orderType: {
      type: String,
      enum: ["Membership", "Store", "Space", "Services", "Food", "Milestone", "Other"],
      default: "Other",
    },
    orderAmount: {
      type: Number,
      default: 0,
    },
    commissionAmount: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      enum: ["Hold", "Approved", "Cancelled", "Paid"],
      default: "Hold",
      index: true,
    },
    holdUntil: {
      type: Date,
      default: null,
    },
    milestoneBonus: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

const CommissionLedger = mongoose.model("CommissionLedger", commissionLedgerSchema);

export default CommissionLedger;

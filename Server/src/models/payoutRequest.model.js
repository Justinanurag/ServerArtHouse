import mongoose from "mongoose";

const payoutRequestSchema = new mongoose.Schema(
  {
    affiliateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 1,
    },
    status: {
      type: String,
      enum: ["Pending", "In Process", "Paid", "Failed"],
      default: "Pending",
      index: true,
    },
    payoutMethod: {
      type: String,
      enum: ["Bank Transfer", "UPI", "Manual", "Other"],
      default: "Other",
    },
    payoutDetails: {
      type: mongoose.Schema.Types.Mixed,
      default: {}, // Store a snapshot of the bank/upi details at the time of request
    },
    transactionId: {
      type: String,
      default: null,
      trim: true,
    },
    failureReason: {
      type: String,
      default: null,
      trim: true,
    },
    requestedAt: {
      type: Date,
      default: Date.now,
    },
    processedAt: {
      type: Date,
      default: null,
    },
    processedBy: {
      m_staff_id: { type: String, default: null },
      m_staff_name: { type: String, default: null },
    },
  },
  {
    timestamps: true,
  }
);

// Pre-save hook to generate a default transaction ID for Paid if not provided
payoutRequestSchema.pre("save", function (next) {
  if (this.status === "Paid" && !this.transactionId) {
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let txn = "TXN";
    for (let i = 0; i < 8; i++) {
      txn += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    this.transactionId = txn;
  }
  next();
});

const PayoutRequest = mongoose.model("PayoutRequest", payoutRequestSchema);

export default PayoutRequest;

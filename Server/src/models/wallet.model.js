import mongoose from "mongoose";

const walletTransactionSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      default: null,
    },
    type: {
      type: String,
      enum: ["credit", "debit"],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    // Which bucket this tx affects (legacy: cashback/affiliate/general)
    walletType: {
      type: String,
      enum: [
        "cashback",
        "affiliate",
        "general",
        "withdrawable",
        "nonWithdrawable",
      ],
      default: "nonWithdrawable",
    },
    withdrawableDeducted: {
      type: Number,
      default: 0,
      min: 0,
    },
    nonWithdrawableDeducted: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalBalanceBefore: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalBalanceAfter: {
      type: Number,
      default: 0,
      min: 0,
    },
    withdrawableAfter: {
      type: Number,
      default: 0,
      min: 0,
    },
    nonWithdrawableAfter: {
      type: Number,
      default: 0,
      min: 0,
    },
    reason: {
      type: String,
      default: "",
      trim: true,
    },
    note: {
      type: String,
      default: "",
      trim: true,
    },
    referenceType: {
      type: String,
      default: "",
      trim: true,
    },
    referenceId: {
      type: String,
      default: "",
      trim: true,
    },
    idempotencyKey: {
      type: String,
      default: null,
      trim: true,
    },
    previousBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    createdBy: {
      m_staff_id: { type: String, default: null },
      m_staff_name: { type: String, default: null },
      m_staff_email: { type: String, default: null },
    },
    closingBalance: {
      type: Number,
      required: true,
      min: 0,
    },
    affiliateBalanceAfter: {
      type: Number,
      default: 0,
      min: 0,
    },
    cashbackBalanceAfter: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  { timestamps: true },
);

const walletSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      unique: true,
      index: true,
    },
    customerName: {
      type: String,
      required: true,
      trim: true,
    },
    customerPhone: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    walletAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    // 2 = canonical withdrawable + nonWithdrawable (walletAmount is derived total)
    balanceSchema: {
      type: Number,
      enum: [1, 2],
    },
    withdrawable: {
      type: Number,
      min: 0,
    },
    nonWithdrawable: {
      type: Number,
      min: 0,
    },
    // Withdrawable alias (affiliate / referral / CSP)
    affiliateBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Non-withdrawable alias (cashback + other restricted credits)
    cashbackBalance: {
      type: Number,
      default: 0,
      min: 0,
    },
    // Reserved for pending withdrawal requests
    affiliateReserved: {
      type: Number,
      default: 0,
      min: 0,
    },
    transactions: {
      type: [walletTransactionSchema],
      default: [],
    },
  },
  { timestamps: true },
);

walletSchema.index({ customerName: 1 });
walletSchema.index({ "transactions.idempotencyKey": 1 }, { sparse: true });

const Wallet = mongoose.model("Wallet", walletSchema);

export default Wallet;

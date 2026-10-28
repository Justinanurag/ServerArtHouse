import mongoose from 'mongoose';

const walletWithdrawalSchema = new mongoose.Schema(
  {
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 1,
    },
    method: {
      type: String,
      enum: ['upi', 'bank'],
      default: 'upi',
    },
    payoutDetails: {
      upiId: {type: String, default: '', trim: true},
      accountHolderName: {type: String, default: '', trim: true},
      accountNumber: {type: String, default: '', trim: true},
      ifsc: {type: String, default: '', trim: true, uppercase: true},
      bankName: {type: String, default: '', trim: true},
    },
    status: {
      type: String,
      enum: ['requested', 'under_review', 'approved', 'paid', 'rejected'],
      default: 'requested',
      index: true,
    },
    // Funds reserved from affiliateBalance when request is created
    reserved: {
      type: Boolean,
      default: true,
    },
    note: {
      type: String,
      default: '',
      trim: true,
    },
    adminNote: {
      type: String,
      default: '',
      trim: true,
    },
    reviewedBy: {
      m_staff_id: {type: String, default: null},
      m_staff_name: {type: String, default: null},
      m_staff_email: {type: String, default: null},
    },
    reviewedAt: {type: Date, default: null},
    paidAt: {type: Date, default: null},
    rejectedAt: {type: Date, default: null},
    walletDebitRef: {type: String, default: null},
  },
  {timestamps: true},
);

walletWithdrawalSchema.index({customer: 1, createdAt: -1});
walletWithdrawalSchema.index({status: 1, createdAt: -1});

const WalletWithdrawal = mongoose.model('WalletWithdrawal', walletWithdrawalSchema);
export default WalletWithdrawal;

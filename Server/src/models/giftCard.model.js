import mongoose from 'mongoose';

export const GIFT_CARD_STATUSES = ['Active', 'Used', 'Expired', 'Cancelled'];
export const GIFT_CARD_TXN_TYPES = ['issue', 'redeem', 'refund', 'adjust'];

const staffSchema = new mongoose.Schema(
  {
    m_staff_id: {type: String, default: null},
    m_staff_name: {type: String, default: null},
    m_staff_email: {type: String, default: null},
  },
  {_id: false},
);

const transactionSchema = new mongoose.Schema(
  {
    type: {type: String, enum: GIFT_CARD_TXN_TYPES, required: true},
    /** Signed change to the balance (redeem is negative). */
    amount: {type: Number, required: true},
    balanceAfter: {type: Number, required: true, min: 0},
    reference: {type: String, default: '', trim: true},
    note: {type: String, default: '', trim: true},
    by: {type: staffSchema, default: () => ({})},
    at: {type: Date, default: Date.now},
  },
  {_id: true},
);

const giftCardSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    initialAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    currentBalance: {
      type: Number,
      required: true,
      min: 0,
    },
    /** Last valid day (stored as UTC midnight of the calendar date). */
    expiryDate: {
      type: Date,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: GIFT_CARD_STATUSES,
      default: 'Active',
      index: true,
    },
    /** Display name shown in the UI (editable in the form). */
    createdByName: {
      type: String,
      default: '',
      trim: true,
    },
    createdBy: {type: staffSchema, default: () => ({})},
    updatedBy: {type: staffSchema, default: () => ({})},
    /** Random, unguessable token for the public share link; absent when not shared. */
    shareToken: {type: String, default: undefined},
    sharedAt: {type: Date, default: null},
    sharedBy: {type: staffSchema, default: undefined},
    transactions: {type: [transactionSchema], default: []},
  },
  {timestamps: true},
);

giftCardSchema.index({createdAt: -1});
giftCardSchema.index({name: 1});
giftCardSchema.index(
  {shareToken: 1},
  {unique: true, partialFilterExpression: {shareToken: {$type: 'string'}}},
);


export default mongoose.model('GiftCard', giftCardSchema);

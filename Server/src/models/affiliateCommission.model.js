import mongoose from 'mongoose';

const affiliateCommissionSchema = new mongoose.Schema(
  {
    inviter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
      index: true,
    },
    referredCustomer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
      index: true,
    },
    category: {
      type: String,
      enum: [
        'invite',
        'product',
        'space',
        'food',
        'service',
        'membership',
        'other',
      ],
      required: true,
      index: true,
    },
    sourceType: {
      type: String,
      default: '',
      trim: true,
    },
    sourceId: {
      type: String,
      default: '',
      trim: true,
      index: true,
    },
    orderAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    commissionType: {
      type: String,
      enum: ['percentage', 'fixed'],
      required: true,
    },
    commissionValue: {
      type: Number,
      required: true,
      min: 0,
    },
    commissionAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'credited', 'cancelled', 'reversed'],
      default: 'pending',
      index: true,
    },
    // Prevents double credit on retries
    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    walletTransactionId: {
      type: String,
      default: null,
    },
    approvedAt: {type: Date, default: null},
    creditedAt: {type: Date, default: null},
    cancelledAt: {type: Date, default: null},
    reversedAt: {type: Date, default: null},
    reverseOf: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AffiliateCommission',
      default: null,
    },
    meta: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {timestamps: true},
);

affiliateCommissionSchema.index({inviter: 1, createdAt: -1});
affiliateCommissionSchema.index({referredCustomer: 1, category: 1});
affiliateCommissionSchema.index({sourceType: 1, sourceId: 1});

const AffiliateCommission = mongoose.model(
  'AffiliateCommission',
  affiliateCommissionSchema,
);
export default AffiliateCommission;

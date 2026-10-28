import mongoose from 'mongoose';

/**
 * Durable CSP payment split ledger.
 * 70% → sailor wallet (recorded here for audit)
 * 30% → platform retention (stored here for future use — never walleted)
 *
 * Unique invoiceCode prevents duplicate settlement on retries.
 */
const cspSettlementLineSchema = new mongoose.Schema(
  {
    productName: {type: String, trim: true, default: ''},
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      default: null,
    },
    cspEnrollmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CustomerSellerProgram',
      default: null,
    },
    cspCustomerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      default: null,
    },
    lineBaseAmount: {type: Number, min: 0, default: 0},
    sailorSharePercent: {type: Number, min: 0, max: 100, default: 70},
    platformSharePercent: {type: Number, min: 0, max: 100, default: 30},
    sailorAmount: {type: Number, min: 0, default: 0},
    platformAmount: {type: Number, min: 0, default: 0},
  },
  {_id: false},
);

const cspSettlementSchema = new mongoose.Schema(
  {
    invoiceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Invoice',
      required: true,
      index: true,
    },
    /** Idempotency key — one settlement per invoice */
    invoiceCode: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true,
    },
    sailorTotal: {
      type: Number,
      min: 0,
      default: 0,
    },
    /** 30% retained for platform / future use — NOT credited to sailor wallet */
    platformTotal: {
      type: Number,
      min: 0,
      default: 0,
    },
    lines: {
      type: [cspSettlementLineSchema],
      default: [],
    },
    sailorCredits: [
      {
        customerId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Customer',
        },
        amount: {type: Number, min: 0, default: 0},
        _id: false,
      },
    ],
    status: {
      type: String,
      enum: ['settled', 'reversed'],
      default: 'settled',
      index: true,
    },
    settledAt: {
      type: Date,
      default: Date.now,
    },
    reversedAt: {
      type: Date,
      default: null,
    },
    createdBy: {
      m_staff_id: {type: String, default: null},
      m_staff_name: {type: String, default: null},
      m_staff_email: {type: String, default: null},
    },
  },
  {timestamps: true},
);

cspSettlementSchema.index({status: 1, settledAt: -1});

const CspSettlement = mongoose.model('CspSettlement', cspSettlementSchema);
export default CspSettlement;

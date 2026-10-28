import mongoose from 'mongoose';

const vendorPaymentSchema = new mongoose.Schema(
  {
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      required: true,
      index: true,
    },
    /** pay-out: we pay the vendor. pay-in: the vendor pays us. adjustment: balance correction. */
    direction: {
      type: String,
      enum: ['pay-out', 'pay-in', 'adjustment'],
      required: true,
    },
    /** increase adds to what we owe; decrease reduces it. Used only for adjustments. */
    adjustmentEffect: {
      type: String,
      enum: ['increase', 'decrease', ''],
      default: '',
    },
    amount: {type: Number, required: true, min: 0},
    /** Portion applied to a purchase bill. The rest is an advance. */
    appliedAmount: {type: Number, default: 0, min: 0},
    advanceAmount: {type: Number, default: 0, min: 0},
    method: {
      type: String,
      enum: ['Cash', 'UPI', 'Card', 'Bank', 'Other', ''],
      default: '',
    },
    reference: {type: String, default: '', trim: true},
    note: {type: String, default: '', trim: true},
    paidAt: {type: Date, default: Date.now},
    purchaseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Purchase',
      default: null,
    },
    purchaseInvoice: {type: String, default: '', trim: true},
    allocations: [
      {
        purchaseId: {type: mongoose.Schema.Types.ObjectId, ref: 'Purchase'},
        purchaseInvoice: {type: String, default: ''},
        amount: {type: Number, default: 0, min: 0},
      },
    ],
    documents: [
      {
        url: {type: String, default: '', trim: true},
        name: {type: String, default: '', trim: true},
        mimeType: {type: String, default: '', trim: true},
        size: {type: Number, default: 0, min: 0},
      },
    ],
    history: [
      {
        action: {type: String, default: 'created'},
        amount: {type: Number, default: 0},
        note: {type: String, default: ''},
        at: {type: Date, default: Date.now},
        byName: {type: String, default: ''},
      },
    ],
    /** Caller-generated key so a retried request does not record the payment twice. */
    clientKey: {type: String, default: '', trim: true},
    createdBy: {
      m_staff_id: {type: String, default: null},
      m_staff_name: {type: String, default: null},
      m_staff_email: {type: String, default: null},
    },
  },
  {timestamps: true},
);

vendorPaymentSchema.index(
  {vendorId: 1, clientKey: 1},
  {unique: true, partialFilterExpression: {clientKey: {$gt: ''}}},
);

export default mongoose.model('VendorPayment', vendorPaymentSchema);

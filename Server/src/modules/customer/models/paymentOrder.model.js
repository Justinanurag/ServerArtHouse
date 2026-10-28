import mongoose from 'mongoose';

const paymentOrderSchema = new mongoose.Schema(
  {
    txnid: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
      index: true,
    },
    membershipType: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    couponCode: {
      type: String,
      default: null,
      uppercase: true,
      trim: true,
    },
    orderAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    discountAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    paidAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: 'INR',
    },
    status: {
      type: String,
      enum: ['created', 'pending', 'success', 'failed', 'cancelled'],
      default: 'created',
      index: true,
    },
    gateway: {
      type: String,
      default: 'payu',
    },
    mihpayid: {type: String, default: null},
    bankRefNum: {type: String, default: null},
    paymentMode: {type: String, default: null},
    gatewayStatus: {type: String, default: null},
    errorMessage: {type: String, default: null},
    rawResponse: {type: mongoose.Schema.Types.Mixed, default: null},
    activatedAt: {type: Date, default: null},
  },
  {timestamps: true},
);

paymentOrderSchema.index({customer: 1, createdAt: -1});

const PaymentOrder = mongoose.model('PaymentOrder', paymentOrderSchema);
export default PaymentOrder;

import mongoose from 'mongoose';

/**
 * Payment intent for a customer self-booking.
 * The SpaceBooking row is created only after Razorpay is verified.
 */
const customerSpaceCheckoutSchema = new mongoose.Schema(
  {
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
      index: true,
    },
    spaceId: {type: mongoose.Schema.Types.ObjectId, ref: 'Space', default: null},
    bookingDate: {type: String, required: true},
    startTime: {type: String, required: true},
    endTime: {type: String, required: true},
    couponCode: {type: String, default: ''},
    payable: {type: Number, required: true, min: 0},
    quote: {type: mongoose.Schema.Types.Mixed, default: null},
    razorpayOrderId: {type: String, default: '', index: true},
    razorpayPaymentId: {type: String, default: ''},
    bookingId: {type: mongoose.Schema.Types.ObjectId, ref: 'SpaceBooking', default: null},
    status: {
      type: String,
      enum: ['pending', 'verifying', 'paid', 'failed', 'slot_taken'],
      default: 'pending',
    },
  },
  {timestamps: true},
);

customerSpaceCheckoutSchema.index({customer: 1, createdAt: -1});

export default mongoose.model('CustomerSpaceCheckout', customerSpaceCheckoutSchema);

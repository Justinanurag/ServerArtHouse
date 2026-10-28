import mongoose from 'mongoose';

const bookingPaymentSettingsSchema = new mongoose.Schema(
  {
    key: {type: String, default: 'default', unique: true, index: true},
    enablePartialPayment: {type: Boolean, default: true},
    minimumPaymentType: {
      type: String,
      enum: ['percentage', 'fixed'],
      default: 'percentage',
    },
    minimumPaymentValue: {type: Number, default: 70, min: 0},
    paymentInstructions: {type: String, default: '', trim: true, maxlength: 500},
    /** Percent of the amount already paid that can be refunded after cancellation. */
    refundPercent: {type: Number, default: 100, min: 0, max: 100},
    updatedBy: {
      m_staff_id: {type: String, default: null},
      m_staff_name: {type: String, default: null},
      m_staff_email: {type: String, default: null},
    },
  },
  {timestamps: true},
);

export default mongoose.model('BookingPaymentSettings', bookingPaymentSettingsSchema);

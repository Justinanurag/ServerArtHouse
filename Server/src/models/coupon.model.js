import mongoose from 'mongoose';

const couponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    discountType: {
      type: String,
      enum: ['percentage', 'flat'],
      required: true,
    },
    discountValue: {
      type: Number,
      required: true,
      min: 0,
    },
    minOrderAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    maxDiscountAmount: {
      type: Number,
      default: null,
      min: 0,
    },
    startsAt: {
      type: Date,
      default: null,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    usageLimit: {
      type: Number,
      default: null,
      min: 1,
    },
    perCustomerLimit: {
      type: Number,
      default: null,
      min: 1,
    },
    usedCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    /** Where coupon applies: all | store | space | service | food | membership */
    applicableOn: {
      type: [
        {
          type: String,
          enum: ['all', 'store', 'space', 'service', 'food', 'membership'],
        },
      ],
      default: ['all'],
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      m_staff_id: { type: String, default: null },
      m_staff_name: { type: String, default: null },
      m_staff_email: { type: String, default: null },
    },
  },
  { timestamps: true },
);

const Coupon = mongoose.model('Coupon', couponSchema);
export default Coupon;

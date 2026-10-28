import mongoose from 'mongoose';

const quotationItemSchema = new mongoose.Schema(
  {
    productName: {
      type: String,
      required: true,
      trim: true,
    },
    qty: {
      type: Number,
      required: true,
      min: 1,
    },
    unitPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    discount: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    cashback: {
      type: Number,
      min: 0,
      default: 0,
    },
    category: {
      type: String,
      trim: true,
      default: 'General',
    },
    isCsp: {
      type: Boolean,
      default: false,
    },
    productDiscountType: {
      type: String,
      trim: true,
      default: '',
    },
    productDiscountValue: {
      type: Number,
      min: 0,
      default: 0,
    },
    productDiscountAmount: {
      type: Number,
      min: 0,
      default: 0,
    },
    membershipDiscountAmount: {
      type: Number,
      min: 0,
      default: 0,
    },
    lineTotal: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  {_id: false},
);

const quotationSchema = new mongoose.Schema(
  {
    quotationPrefix: {
      type: String,
      required: true,
      default: 'QUOTVWAH',
      trim: true,
    },
    quotationNumber: {
      type: Number,
      required: true,
      unique: true,
      index: true,
    },
    quotationCode: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
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
    },
    quotationDate: {
      type: Date,
      required: true,
    },
    dueDate: {
      type: Date,
      required: true,
    },
    salesPersonName: {
      type: String,
      required: true,
      trim: true,
    },
    notes: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: ['draft', 'sent', 'accepted', 'rejected'],
      default: 'draft',
    },
    items: {
      type: [quotationItemSchema],
      default: [],
    },
    subTotal: {
      type: Number,
      required: true,
      min: 0,
    },
    discountTotal: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    membershipType: {
      type: String,
      trim: true,
      default: '',
    },
    membershipPlanId: {
      type: String,
      trim: true,
      default: '',
    },
    membershipDiscount: {
      type: Number,
      min: 0,
      default: 0,
    },
    cashbackTotal: {
      type: Number,
      min: 0,
      default: 0,
    },
    extraCharges: [
      {
        label: { type: String, trim: true },
        amount: { type: Number, default: 0 },
      },
    ],
    coupon: {
      code: { type: String, trim: true, uppercase: true, default: null },
      title: { type: String, trim: true, default: null },
      discountType: {
        type: String,
        enum: ['percentage', 'flat', null],
        default: null,
      },
      discountValue: { type: Number, min: 0, default: 0 },
      discountAmount: { type: Number, min: 0, default: 0 },
    },
    grandTotal: {
      type: Number,
      required: true,
      min: 0,
    },
    createdBy: {
      m_staff_id: {type: String, default: null},
      m_staff_name: {type: String, default: null},
      m_staff_email: {type: String, default: null},
    },
  },
  {timestamps: true},
);

const Quotation = mongoose.model('Quotation', quotationSchema);
export default Quotation;

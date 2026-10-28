import mongoose from 'mongoose';

const subscriptionItemSchema = new mongoose.Schema(
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
    lineTotal: {
      type: Number,
      required: true,
      min: 0,
    },
  },
  {_id: false},
);

const juniorStudentSchema = new mongoose.Schema(
  {
    // Bulk junior import may leave these blank; UI create still validates them.
    studentName: {type: String, default: '', trim: true},
    schoolName: {type: String, default: '', trim: true},
    dob: {type: Date, default: null},
    gender: {type: String, default: '', trim: true},
    classStd: {type: String, default: '', trim: true},
    relation: {type: String, default: '', trim: true},
    parentName: {type: String, default: '', trim: true},
    studentId: {type: String, default: '', trim: true},
    studentIdUpload: {type: String, default: '', trim: true},
    formImageUpload: {type: String, default: '', trim: true},
  },
  {_id: false},
);

const subscriptionSchema = new mongoose.Schema(
  {
    subscriptionPrefix: {
      type: String,
      required: true,
      default: 'SUB',
      trim: true,
    },
    subscriptionNumber: {
      type: Number,
      required: true,
      unique: true,
      index: true,
    },
    subscriptionCode: {
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
    membershipId: {
      type: String,
      default: '',
      trim: true,
      index: true,
    },
    membershipPlanId: {
      type: String,
      default: '',
      trim: true,
      index: true,
    },
    membershipType: {
      type: String,
      default: 'general',
      trim: true,
      lowercase: true,
      index: true,
    },
    /** Snapshot of membership plan priority at purchase / upgrade time */
    priority: {
      type: Number,
      default: 0,
      min: 0,
      index: true,
    },
    invoiceDate: {
      type: Date,
      required: true,
    },
    dueDate: {
      type: Date,
      required: false,
      default: null,
    },
    startDate: {
      type: Date,
      required: true,
    },
    endDate: {
      type: Date,
      required: false,
      default: null,
    },
    repeatType: {
      type: String,
      enum: ['weekly', 'monthly', 'yearly', 'lifetime'],
      default: 'monthly',
    },
    repeatEvery: {
      type: Number,
      default: 1,
      min: 1,
    },
    repeatUnit: {
      type: String,
      enum: ['month', 'year', null],
      default: 'month',
    },
    noOfInvoices: {
      type: Number,
      min: 0,
      default: 0,
    },
    nextInvoiceDate: {
      type: Date,
      default: null,
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
      enum: ['draft', 'active', 'completed', 'expired', 'error', 'cancelled'],
      default: 'active',
    },
    items: {
      type: [subscriptionItemSchema],
      default: [],
    },
    students: {
      type: [juniorStudentSchema],
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
    grandTotal: {
      type: Number,
      required: true,
      min: 0,
    },
    referral: {
      code: {type: String, default: '', trim: true},
      inviterName: {type: String, default: '', trim: true},
      label: {type: String, default: '', trim: true},
      discountAmount: {type: Number, default: 0, min: 0},
    },
    coupon: {
      code: {type: String, default: '', trim: true},
      title: {type: String, default: '', trim: true},
      discountAmount: {type: Number, default: 0, min: 0},
    },
    mode: {
      type: String,
      default: '',
      trim: true,
    },
    paymentStatus: {
      type: String,
      default: 'Paid (Full)',
      trim: true,
    },
    paymentBreakdown: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    createdBy: {
      m_staff_id: {type: String, default: null},
      m_staff_name: {type: String, default: null},
      m_staff_email: {type: String, default: null},
    },
    /** Last membershiprenewal WhatsApp reminder attempt */
    lastRenewalReminderAt: {type: Date, default: null},
    lastRenewalReminderStatus: {
      type: String,
      enum: ['success', 'failed', ''],
      default: '',
    },
    lastRenewalReminderMessageId: {type: String, default: null},
  },
  {timestamps: true},
);

subscriptionSchema.index({customerName: 1});
subscriptionSchema.index({createdAt: -1});
subscriptionSchema.index({status: 1});

const Subscription = mongoose.model('Subscription', subscriptionSchema);
export default Subscription;

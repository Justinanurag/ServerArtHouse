import mongoose from 'mongoose';

const invoiceItemSchema = new mongoose.Schema(
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
    category: {
      type: String,
      trim: true,
      default: 'General',
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      default: null,
    },
    isCsp: {
      type: Boolean,
      default: false,
    },
    cspEnrollmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CustomersailorProgram',
      default: null,
    },
    cspCustomerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      default: null,
    },
    cspsailorAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    /** Platform / future-use share (default 30%) — stored, never walleted to sailor */
    cspPlatformAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    /** Complimentary / gift line — refund value is 0 */
    isGift: {
      type: Boolean,
      default: false,
    },
    /** Membership cashback ₹ for this line (stored for proportional reverse on return). */
    cashback: {
      type: Number,
      default: 0,
      min: 0,
    },
    /** Catalogue product discount ₹ already inside `discount`. */
    productDiscountAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    /** Membership discount ₹ already inside `discount` (do not apply again on edit). */
    membershipDiscountAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    /** Accumulated qty already returned against this line */
    returnedQty: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {_id: false},
);

const invoiceSchema = new mongoose.Schema(
  {
    invoicePrefix: {
      type: String,
      required: true,
      default: 'INVVWAH',
      trim: true,
    },
    invoiceNumber: {
      type: Number,
      required: true,
      unique: true,
      index: true,
    },
    invoiceCode: {
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
    /** Exact CRM customer linked at invoice create (prefer over name search). */
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      default: null,
      index: true,
    },
    invoiceDate: {
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
    /**
     * Staff who verified the bill via PIN (not the logged-in session user).
     * createdBy remains the authenticated user from User Context.
     */
    invoiceBy: {
      staffId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
      },
      staffName: {
        type: String,
        default: '',
        trim: true,
      },
      employeeId: {
        type: String,
        default: '',
        trim: true,
      },
      email: {
        type: String,
        default: '',
        trim: true,
      },
    },
    verifiedAt: {
      type: Date,
      default: null,
    },
    notes: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: ['draft', 'final', 'cancelled'],
      default: 'final',
    },
    items: {
      type: [invoiceItemSchema],
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
    referral: {
      code: { type: String, trim: true, uppercase: true, default: null },
      inviterName: { type: String, trim: true, default: null },
      discountType: {
        type: String,
        enum: ['percentage', 'fixed', null],
        default: null,
      },
      discountValue: { type: Number, min: 0, default: 0 },
      discountAmount: { type: Number, min: 0, default: 0 },
      label: { type: String, trim: true, default: 'Referral Discount' },
    },
    manualDiscount: {
      type: {
        type: String,
        enum: ['percentage', 'flat', null],
        default: null,
      },
      value: { type: Number, min: 0, default: 0 },
      discountAmount: { type: Number, min: 0, default: 0 },
    },
    grandTotal: {
      type: Number,
      required: true,
      min: 0,
    },
    extraCharges: [
      {
        label: { type: String, trim: true },
        amount: { type: Number, default: 0 }
      }
    ],
    /** Membership discount amount applied at checkout (₹). */
    membershipDiscount: {
      type: Number,
      min: 0,
      default: 0,
    },
    /** Customer membership plan at time of invoice (e.g. premium, pro). */
    membershipType: {
      type: String,
      trim: true,
      default: '',
    },
    /** Membership cashback credited to wallet for this invoice (₹). */
    cashbackTotal: {
      type: Number,
      min: 0,
      default: 0,
    },
    /** Cashback already reversed from wallet (cancel / delete / returns). */
    cashbackReversedTotal: {
      type: Number,
      min: 0,
      default: 0,
    },
    /** Sum of CSP sailor shares (70%) credited to owner wallets after full payment. */
    cspSailorTotal: {
      type: Number,
      min: 0,
      default: 0,
    },
    /** Sum of CSP platform shares (30%) retained in DB for future use. */
    cspPlatformTotal: {
      type: Number,
      min: 0,
      default: 0,
    },
    /** When CSP 70/30 split was settled (null = not yet / not applicable). */
    cspSettledAt: {
      type: Date,
      default: null,
    },
    /** Remaining due (mirrors paymentBreakdown.dueAmount). */
    pendingAmount: {
      type: Number,
      min: 0,
      default: 0,
    },
    mode: {
      type: String,
      trim: true,
      default: 'Cash',
    },
    paymentStatus: {
      type: String,
      enum: ['full', 'partial', 'due'],
      default: 'full',
    },
    paymentBreakdown: {
      cash: {type: Number, min: 0, default: 0},
      upi: {type: Number, min: 0, default: 0},
      card: {type: Number, min: 0, default: 0},
      wallet: {type: Number, min: 0, default: 0},
      paidAmount: {type: Number, min: 0, default: 0},
      dueAmount: {type: Number, min: 0, default: 0},
      changeAmount: {type: Number, min: 0, default: 0},
    },
    paymentHistory: [
      {
        date: { type: Date, default: Date.now },
        amount: { type: Number, required: true },
        mode: { type: String, required: true },
        receivedBy: { type: String, default: null }
      }
    ],
    /** Sum of refunded/returned value processed against this invoice */
    returnedAmount: {
      type: Number,
      min: 0,
      default: 0,
    },
    createdBy: {
      m_staff_id: {type: String, default: null},
      m_staff_name: {type: String, default: null},
      m_staff_email: {type: String, default: null},
    },
  },
  {timestamps: true},
);

const Invoice = mongoose.model('Invoice', invoiceSchema);
export default Invoice;

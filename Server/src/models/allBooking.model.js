import mongoose from 'mongoose';

const lineSchema = new mongoose.Schema(
  {
    refId: {type: mongoose.Schema.Types.ObjectId, default: null},
    label: {type: String, required: true, trim: true},
    price: {type: Number, default: 0, min: 0},
    qty: {type: Number, default: 1, min: 1},
    unit: {type: String, default: '', trim: true},
    category: {type: String, default: '', trim: true},
  },
  {_id: false},
);

const allBookingSchema = new mongoose.Schema(
  {
    bookingCode: {type: String, default: '', trim: true, index: true},
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      default: null,
    },
    customerName: {type: String, required: true, trim: true},
    customerPhone: {type: String, required: true, trim: true},
    customerEmail: {type: String, default: '', trim: true, lowercase: true},
    spaceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Space',
      default: null,
      index: true,
    },
    spaceName: {type: String, default: '', trim: true},
    spaceCode: {type: String, default: '', trim: true},
    spaceType: {type: String, default: '', trim: true},
    spaceCategory: {type: String, default: '', trim: true},
    spaceDay: {type: String, default: '', trim: true},
    unitPrice: {type: Number, default: 0, min: 0},
    spaceQty: {type: Number, default: 1, min: 1},
    durationHours: {type: Number, default: 0, min: 0},
    bookingDate: {type: Date, default: null, index: true},
    startTime: {type: String, default: '', trim: true},
    endTime: {type: String, default: '', trim: true},
    services: {type: [lineSchema], default: []},
    foods: {type: [lineSchema], default: []},
    membershipType: {type: String, default: '', trim: true},
    membershipDiscount: {type: Number, default: 0, min: 0},
    cashbackTotal: {type: Number, default: 0, min: 0},
    subTotal: {type: Number, default: 0, min: 0},
    grandTotal: {type: Number, default: 0, min: 0},
    paidAmount: {type: Number, default: 0, min: 0},
    dueAmount: {type: Number, default: 0, min: 0},
    status: {
      type: String,
      enum: ['Upcoming', 'Ongoing', 'Expired', 'Cancelled', 'Draft'],
      default: 'Draft',
      index: true,
    },
    notes: {type: String, default: '', trim: true},
    paymentStatus: {type: String, default: '', trim: true},
    createdBy: {
      m_staff_id: {type: String, default: null},
      m_staff_name: {type: String, default: null},
      m_staff_email: {type: String, default: null},
    },
    cancellation: {
      reason: {type: String, default: '', trim: true},
      cancelledAt: {type: Date, default: null},
      cancelledBy: {
        m_staff_id: {type: String, default: null},
        m_staff_name: {type: String, default: null},
        m_staff_email: {type: String, default: null},
      },
    },
    cancellationHistory: [
      {
        reason: {type: String, default: '', trim: true},
        cancelledAt: {type: Date, default: null},
        cancelledBy: {
          m_staff_id: {type: String, default: null},
          m_staff_name: {type: String, default: null},
          m_staff_email: {type: String, default: null},
        },
      },
    ],
    refund: {
      amount: {type: Number, default: 0, min: 0},
      refundableAmount: {type: Number, default: 0, min: 0},
      status: {
        type: String,
        enum: ['', 'Pending', 'Processing', 'Completed', 'Failed'],
        default: '',
      },
      refundedAt: {type: Date, default: null},
      paymentReference: {type: String, default: '', trim: true},
      method: {type: String, default: '', trim: true},
      history: [
        {
          status: {type: String, default: ''},
          amount: {type: Number, default: 0, min: 0},
          at: {type: Date, default: null},
          note: {type: String, default: '', trim: true},
          paymentReference: {type: String, default: '', trim: true},
          method: {type: String, default: '', trim: true},
          by: {
            m_staff_id: {type: String, default: null},
            m_staff_name: {type: String, default: null},
            m_staff_email: {type: String, default: null},
          },
        },
      ],
    },
  },
  {timestamps: true},
);

allBookingSchema.index({customerPhone: 1});
allBookingSchema.index({createdAt: -1});

export default mongoose.model('AllBooking', allBookingSchema);

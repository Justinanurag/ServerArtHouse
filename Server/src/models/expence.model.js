import mongoose from 'mongoose';

const expenceSchema = new mongoose.Schema(
  {
    expenseCode: {type: String, trim: true, default: ''},
    title: {type: String, required: true, trim: true},
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ExpenceCategory',
      default: null,
    },
    segment: { type: String, trim: true, default: '', enum: ['Store','Cafe','Services','Space','general',''] },
    category: {
      type: String,
      trim: true,
      default: 'Other',
    },
    amount: {type: Number, required: true, min: 0},
    paidAmount: {type: Number, min: 0, default: 0},
    dueAmount: {type: Number, min: 0, default: 0},
    paymentBreakdown: {
      cash: {type: Number, min: 0, default: 0},
      upi: {type: Number, min: 0, default: 0},
      card: {type: Number, min: 0, default: 0},
      wallet: {type: Number, min: 0, default: 0},
    },
    payments: [
      {
        amount: {type: Number, required: true, min: 0},
        mode: {type: String, trim: true, default: 'Cash'},
        paymentBreakdown: {
          cash: {type: Number, min: 0, default: 0},
          upi: {type: Number, min: 0, default: 0},
          card: {type: Number, min: 0, default: 0},
          wallet: {type: Number, min: 0, default: 0},
        },
        receivedBy: {
          m_staff_id: {type: String, default: null},
          m_staff_name: {type: String, default: null},
          m_staff_email: {type: String, default: null},
        },
        notes: {type: String, trim: true, default: ''},
        paidAt: {type: Date, default: Date.now},
      },
    ],
    paidTo: {type: String, trim: true, default: ''},
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      default: null,
    },
    paidBy: {
      m_staff_id: {type: String, default: null},
      m_staff_name: {type: String, default: null},
      m_staff_email: {type: String, default: null},
    },
    mode: {
      type: String,
      trim: true,
      default: 'Cash',
      enum: ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Wallet', 'Due'],
    },
    status: {
      type: String,
      trim: true,
      default: 'Paid',
      enum: ['Paid', 'Pending', 'Cancelled'],
    },
    date: {type: Date, default: Date.now},
    notes: {type: String, trim: true, default: ''},
    receiptUrl: {type: String, trim: true, default: ''},
    createdBy: {
      m_staff_id: {type: String, default: null},
      m_staff_name: {type: String, default: null},
      m_staff_email: {type: String, default: null},
    },
    addedBy: {
      m_staff_id: {type: String, default: null},
      m_staff_name: {type: String, default: null},
      m_staff_email: {type: String, default: null},
    },
  },
  {timestamps: true},
);

const Expence = mongoose.models.Expence || mongoose.model('Expence', expenceSchema);

export default Expence;
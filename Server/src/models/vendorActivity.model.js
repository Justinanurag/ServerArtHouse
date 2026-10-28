import mongoose from 'mongoose';

const vendorActivitySchema = new mongoose.Schema(
  {
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      required: true,
      index: true,
    },
    type: {type: String, default: 'updated', trim: true},
    title: {type: String, required: true, trim: true},
    detail: {type: String, default: '', trim: true},
    amount: {type: Number, default: 0},
    reference: {type: String, default: '', trim: true},
    at: {type: Date, default: Date.now},
    by: {
      m_staff_id: {type: String, default: null},
      m_staff_name: {type: String, default: null},
      m_staff_email: {type: String, default: null},
    },
  },
  {timestamps: true},
);

vendorActivitySchema.index({vendorId: 1, at: -1});

export default mongoose.model('VendorActivity', vendorActivitySchema);

import mongoose from 'mongoose';

const customerSailorProgramSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
      index: true,
    },
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
      index: true,
    },
    sailorSharePercent: {
      type: Number,
      min: 0,
      max: 100,
      default: 70,
    },
    platformSharePercent: {
      type: Number,
      min: 0,
      max: 100,
      default: 30,
    },
    displayName: {
      type: String,
      trim: true,
      default: '',
    },
    mobile: {
      type: String,
      trim: true,
      default: '',
      index: true,
    },
  },
  {timestamps: true},
);

customerSailorProgramSchema.index(
  {customerId: 1},
  {
    unique: true,
    partialFilterExpression: {status: 'active'},
  },
);

customerSailorProgramSchema.index(
  {vendorId: 1},
  {
    unique: true,
    partialFilterExpression: {status: 'active'},
  },
);

export default mongoose.model(
  'CustomerSailorProgram',
  customerSailorProgramSchema,
);

import mongoose from 'mongoose';

const cspApplicationSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
      index: true,
    },
    brandName: {
      type: String,
      required: true,
      trim: true,
    },
    categories: {
      type: [String],
      default: [],
    },
    prositeUrl: {
      type: String,
      required: true,
      trim: true,
    },
    alreadySelling: {
      type: Boolean,
      default: false,
    },
    sellingPlatforms: {
      type: [String],
      default: [],
    },
    status: {
      type: String,
      enum: ['under_review', 'approved', 'rejected'],
      default: 'under_review',
      index: true,
    },
    rejectionReason: {
      type: String,
      default: '',
      trim: true,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    enrollmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CustomerSailorProgram',
      default: null,
    },
  },
  {timestamps: true},
);

cspApplicationSchema.index({customerId: 1, createdAt: -1});

export default mongoose.model('CspApplication', cspApplicationSchema);

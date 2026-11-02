import mongoose from 'mongoose';

const hapApplicationSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
      index: true,
    },
    profession: {
      type: String,
      required: true,
      trim: true,
    },
    networkSize: {
      type: Number,
      required: true,
      min: 1,
    },
    payoutDetail: {
      type: String,
      required: true,
      trim: true,
    },
    presence: {
      type: String,
      required: true,
      trim: true,
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
  },
  {timestamps: true},
);

hapApplicationSchema.index({customerId: 1, createdAt: -1});

export default mongoose.model('HapApplication', hapApplicationSchema);

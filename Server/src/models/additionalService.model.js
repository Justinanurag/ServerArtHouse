import mongoose from 'mongoose';

const additionalServiceSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [ true, 'Service title is required'],
      trim: true,
    },
    amount: {
      type: Number,
      required: [true, 'Amount is required'],
      min: 0,
    },
    unit: {
      type: String,
      default: 'per month',
      trim: true,
    },
    priceLabel: {
      type: String,
      default: '',
      trim: true,
    },
    icon: {
      type: String,
      default: '',
      trim: true,
    },
    spaceType: {
      type: String,
      enum: ['all', 'coworking', 'exclusive'],
      default: 'all',
    },
    key: {
      type: String,
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);
//2. Automatically generate priceLabel and key before saving
additionalServiceSchema.pre('save', function (next) {
  if (!this.priceLabel) {
    this.priceLabel = `₹${Number(this.amount || 0).toLocaleString('en-IN')} / ${this.unit}`;
  }
  if (!this.key) {
    this.key = this.title.toLowerCase().replace(/[^a-z0-9]/g, '');
  }
  next();
});

const AdditionalService = mongoose.model(
  'AdditionalService',
  additionalServiceSchema
);
export default AdditionalService;

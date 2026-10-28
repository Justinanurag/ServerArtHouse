import mongoose from 'mongoose';

export const EXPENCE_CATEGORY_STATUSES = ['Active', 'Inactive'];

const expenceCategorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    slug: {
      type: String,
      trim: true,
      lowercase: true,
      default: '',
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    status: {
      type: String,
      trim: true,
      default: 'Active',
      enum: EXPENCE_CATEGORY_STATUSES,
    },
    createdBy: {
      m_staff_id: {type: String, default: null},
      m_staff_name: {type: String, default: null},
      m_staff_email: {type: String, default: null},
    },
  },
  {timestamps: true},
);

expenceCategorySchema.pre('validate', function setSlug(next) {
  if (!this.slug && this.name) {
    this.slug = String(this.name)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
  next();
});

expenceCategorySchema.index({status: 1, name: 1});

const ExpenceCategory =
  mongoose.models.ExpenceCategory || mongoose.model('ExpenceCategory', expenceCategorySchema);

export default ExpenceCategory;

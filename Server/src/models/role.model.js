import mongoose from 'mongoose';

/**
 * Role = named bundle of permission keys.
 *
 * Example:
 * {
 *   name: 'Cashier',
 *   slug: 'cashier',
 *   permissions: ['invoice.read', 'invoice.create', 'customer.read']
 * }
 *
 * Users are assigned a role via User.roleId (see auth.model.js).
 */
const roleSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    /** Array of permission keys from the catalog, e.g. 'invoice.create' */
    permissions: {
      type: [String],
      default: [],
    },
    /** System roles (e.g. super_admin) should not be deleted from UI */
    isSystem: {
      type: Boolean,
      default: false,
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {timestamps: true},
);

roleSchema.pre('validate', function normalizeSlug(next) {
  if (this.slug) {
    this.slug = String(this.slug)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_');
  } else if (this.name) {
    this.slug = String(this.name)
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_');
  }
  next();
});

const Role = mongoose.model('Role', roleSchema);
export default Role;

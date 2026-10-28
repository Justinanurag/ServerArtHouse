import mongoose from 'mongoose';

/**
 * Permission definition (metadata for Access UI + validation).
 * The canonical key list also lives in constants/permissions.js.
 *
 * Example doc:
 * { key: 'invoice.create', label: 'Create invoices', module: 'sales' }
 */
const permissionSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    label: {
      type: String,
      required: true,
      trim: true,
    },
    module: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {timestamps: true},
);

permissionSchema.index({module: 1, key: 1});

const Permission = mongoose.model('Permission', permissionSchema);
export default Permission;

import mongoose from 'mongoose';

const foodSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    category: {
      type: String,
      default: 'Snacks',
      trim: true,
    },
    /** Strict entity type — always Food (never Product/Services/Space). */
    itemType: {
      type: String,
      enum: ['food'],
      default: 'food',
      index: true,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    stock: {
      type: Number,
      default: 0,
      min: 0,
    },
    unit: {
      type: String,
      default: 'Plate',
      trim: true,
    },
    /** Off = normal food. On = packaged food. */
    isPackaged: {
      type: Boolean,
      default: false,
    },
    /** Yes = stock comes from purchases and the item is a product. No = current food flow. */
    manageInventory: {
      type: Boolean,
      default: false,
      index: true,
    },
    /** First time inventory was turned on. Earlier food bills do not consume this stock. */
    inventorySince: {
      type: Date,
      default: null,
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      default: null,
      index: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    isVeg: {
      type: Boolean,
      default: true,
    },
    // Cloudinary HTTPS URL (secure_url) saved after upload via CLOUDINARY_URL
    imageUrl: {
      type: String,
      default: null,
      trim: true,
    },
    status: {
      type: String,
      enum: ['Active', 'Inactive'],
      default: 'Active',
      index: true,
    },
    createdBy: {
      m_staff_id: {type: String, default: null},
      m_staff_name: {type: String, default: null},
      m_staff_email: {type: String, default: null},
    },
  },
  {timestamps: true},
);

foodSchema.index({name: 1});
foodSchema.index({category: 1});

export default mongoose.model('Food', foodSchema);

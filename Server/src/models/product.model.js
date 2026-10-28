import mongoose from 'mongoose';

const variantSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    sellingPrice: { type: Number, required: true, min: 0 },
    purchasePrice: { type: Number, required: true, min: 0 },
    barcode: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const productSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['product', 'service'],
      default: 'product',
    },
    productName: {
      type: String,
      required: true,
      trim: true,
    },
    brandName: {
      type: String,
      trim: true,
      default: '',
    },
    serviceName: {
      type: String,
      trim: true,
      default: '',
    },
    sellingPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    purchasePrice: {
      type: Number,
      default: 0,
      min: 0,
    },
    itemCode: {
      type: String,
      trim: true,
      default: '',
    },
    barCode: {
      type: String,
      trim: true,
      default: '',
    },
    subCategory: {
      type: String,
      trim: true,
      default: '',
    },
    category: {
      type: String,
      trim: true,
      default: 'General',
    },
    itemType: {
      type: String,
      enum: ['product', 'service'],
      default: 'product',
    },
    primaryUnit: {
      type: String,
      trim: true,
      default: '',
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    discountType: {
      type: String,
      enum: ['flat', 'percentage'],
      default: 'flat',
    },
    discountValue: {
      type: Number,
      default: 0,
      min: 0,
    },
    stockQty: {
      type: Number,
      default: 0,
    },
    stockStatus: {
      type: String,
      enum: ['in_stock', 'out_of_stock'],
      default: 'in_stock',
    },
    imageUrl: {
      type: String,
      default: null,
    },
    images: {
      type: [String],
      default: [],
    },
    variants: {
      type: [variantSchema],
      default: [],
    },
    /** Customer Sailor Program product flag */
    isCsp: {
      type: Boolean,
      default: false,
      index: true,
    },
    cspEnrollmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CustomersailorProgram',
      default: null,
      index: true,
    },
    cspCustomerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      default: null,
      index: true,
    },
    cspVendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      default: null,
    },
  },
  { timestamps: true }
);

// Prevent duplicate item codes / barcodes when present (empty values ignored)
productSchema.index(
  { itemCode: 1 },
  {
    unique: true,
    partialFilterExpression: {
      itemCode: { $type: 'string', $gt: '' },
    },
  },
);
productSchema.index(
  { barCode: 1 },
  {
    unique: true,
    partialFilterExpression: {
      barCode: { $type: 'string', $gt: '' },
    },
  },
);

// List / search / sort indexes for paginated product catalogue
productSchema.index({ createdAt: -1, _id: -1 });
productSchema.index({ productName: 1 });
productSchema.index({ category: 1 });
productSchema.index({ itemType: 1, type: 1, createdAt: -1 });
productSchema.index({ 'variants.name': 1 });
productSchema.index({ 'variants.barcode': 1 });

const Product = mongoose.model('Product', productSchema);
export default Product;

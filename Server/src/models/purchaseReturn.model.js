import mongoose from "mongoose";

const purchaseReturnItemSchema = new mongoose.Schema(
  {
    productName: { type: String, required: true, trim: true },
    qty: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    lineTotal: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const purchaseReturnSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, required: true, trim: true, index: true },
    invoiceDate: { type: Date, required: true },
    purchaser: { type: String, required: true, trim: true },
    supplierName: { type: String, required: true, trim: true },
    vendorDate: { type: Date, required: true },
    amount: { type: Number, required: true, min: 0 },
    purchaseType: {
      type: String,
      enum: ["cash", "credit"],
      default: "cash",
      index: true,
    },
    paymentMode: {
      type: String,
      enum: ["Cash", "UPI", "Card", "Bank", "Credit", "Other"],
      default: "Cash",
    },
    status: {
      type: String,
      enum: ["draft", "pending", "paid", "partial", "cancelled", "due"],
      default: "pending",
    },
    paidAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    dueAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    items: { type: [purchaseReturnItemSchema], default: [] },
    notes: { type: String, default: "", trim: true },
  },
  { timestamps: true },
);

const PurchaseReturn = mongoose.model("PurchaseReturn", purchaseReturnSchema);

export default PurchaseReturn;

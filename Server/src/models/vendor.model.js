import mongoose from "mongoose";

const pointOfContactSchema = new mongoose.Schema(
  {
    name: { type: String, default: "", trim: true },
    mobile: { type: String, default: "", trim: true },
    email: { type: String, default: "", trim: true, lowercase: true },
    whatsappNumber: { type: String, default: "", trim: true },
    alternateMobile: { type: String, default: "", trim: true },
    dob: { type: Date, default: null },
    gender: { type: String, enum: ["Male", "Female", "Other", ""], default: "" },
    department: { type: String, default: "", trim: true },
    designation: { type: String, default: "", trim: true },
  },
  { _id: false },
);

const vendorSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Vendor name is required"],
      trim: true,
    },

    mobile: {
      type: String,
      required: [true, "Mobile number is required"],
      trim: true,
      unique: true,
    },

    email: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },

    companyName: {
      type: String,
      default: "",
      trim: true,
    },

    businessPhoneNumber: {
      type: String,
      default: "",
      trim: true,
    },

    brandName: {
      type: String,
      default: "",
      trim: true,
    },

    website: {
      type: String,
      default: "",
      trim: true,
    },

    businessEmail: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },

    msme: {
      type: String,
      default: "",
      trim: true,
    },

    udyamNumber: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
    },

    cinNumber: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
    },

    pointsOfContact: {
      type: [pointOfContactSchema],
      default: [],
    },

    documents: {
      type: [
        {
          url: { type: String, default: "", trim: true },
          name: { type: String, default: "", trim: true },
          mimeType: { type: String, default: "", trim: true },
          size: { type: Number, default: 0, min: 0 },
        },
      ],
      default: [],
    },

    gstin: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
    },

    panNumber: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
    },

    adharNumber: {
      type: String,
      default: "",
      trim: true,
    },

    dob: {
      type: Date,
      default: null,
    },

    gender: {
      type: String,
      enum: ["Male", "Female", "Other", ""],
      default: "",
    },

    whatsappNumber: {
      type: String,
      default: "",
      trim: true,
    },

    AlternateMobile: {
      type: String,
      default: "",
      trim: true,
    },

    // Legacy single-line address (kept for older UI)
    address: {
      type: String,
      default: "",
      trim: true,
    },

    // Excel import / billing address split
    billingAddress1: {
      type: String,
      default: "",
      trim: true,
    },
    billingAddress2: {
      type: String,
      default: "",
      trim: true,
    },

    pincode: {
      type: String,
      default: "",
      trim: true,
    },

    city: {
      type: String,
      default: "",
      trim: true,
    },

    state: {
      type: String,
      default: "",
      trim: true,
    },

    country: {
      type: String,
      default: "India",
      trim: true,
    },

    // Financial fields from Excel (Zoho/Tally style exports)
    openingBalance: {
      type: Number,
      default: 0,
    },
    debitLimit: {
      type: Number,
      default: 0,
    },
    /** Due days from Excel "Default Due Date" (often -1 / 0 / N days) */
    defaultDueDays: {
      type: Number,
      default: -1,
    },
    closingBalance: {
      type: Number,
      default: 0,
    },
    netBalance: {
      type: Number,
      default: 0,
    },
    notes: {
      type: String,
      default: "",
      trim: true,
    },

    bankName: {
      type: String,
      default: "",
      trim: true,
    },

    branchName: {
      type: String,
      default: "",
      trim: true,
    },

    accountHolderName: {
      type: String,
      default: "",
      trim: true,
    },

    accountNumber: {
      type: String,
      default: "",
      trim: true,
    },

    IFSCcode: {
      type: String,
      default: "",
      trim: true,
      uppercase: true,
    },

    UPIID: {
      type: String,
      default: "",
      trim: true,
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  },
);

vendorSchema.index({ name: 1 });
vendorSchema.index({ mobile: 1 }, { unique: true });
vendorSchema.index({ companyName: 1 });
vendorSchema.index({ email: 1 });

const Vendor = mongoose.model("Vendor", vendorSchema);

export default Vendor;

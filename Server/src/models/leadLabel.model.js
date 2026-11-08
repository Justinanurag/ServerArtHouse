import mongoose from "mongoose";

const leadLabelSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 40 },
    color: { type: String, required: true, trim: true, default: "#6366F1" },
  },
  { timestamps: true },
);

leadLabelSchema.index({ name: 1 }, { unique: true });

export default mongoose.model("LeadLabel", leadLabelSchema);

import mongoose from "mongoose";

const subCategorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    categoryId: {
      type: String,
      trim: true,
      default: "",
    },
  },
  { timestamps: true },
);

subCategorySchema.index({ name: 1, categoryId: 1 }, { unique: true });

const SubCategory = mongoose.model("SubCategory", subCategorySchema);
export default SubCategory;

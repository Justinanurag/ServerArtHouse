import SubCategory from "../models/subCategory.model.js";
import Product from "../models/product.model.js";

export const getSubCategories = async (req, res) => {
  try {
    const subCategories = await SubCategory.find().sort({ name: 1 });
    return res.status(200).json({ success: true, subCategories });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const addSubCategories = async (req, res) => {
  try {
    const { name, categoryId } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ success: false, message: "Sub category name is required" });
    }

    const created = await SubCategory.create({
      name: name.trim(),
      categoryId: categoryId?.trim?.() ?? "",
    });
    return res.status(201).json({ success: true, subCategory: created });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const updateSubCategories = async (req, res) => {
  try {
    const id = req.params.id || req.body?._id;
    if (!id) {
      return res.status(400).json({ success: false, message: "Sub category id is required" });
    }

    const oldSub = await SubCategory.findById(id);
    const updated = await SubCategory.findByIdAndUpdate(id, req.body, { new: true });

    if (oldSub && req.body.name && oldSub.name !== req.body.name) {
      // Sync all products using the old subcategory name to the new name
      await Product.updateMany({ subCategory: oldSub.name }, { subCategory: req.body.name });
    }

    return res.status(200).json({ success: true, subCategory: updated });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

export const deleteSubCategory = async (req, res) => {
  try {
    const { id } = req.params;

    const subCategoryDoc = await SubCategory.findById(id);
    if (!subCategoryDoc) {
      return res.status(404).json({ success: false, message: "Sub category not found" });
    }

    const isUsed = await Product.findOne({
      $or: [
        { subCategory: id },
        { subCategory: subCategoryDoc.name }
      ]
    });

    if (isUsed) {
      return res.status(400).json({
        success: false,
        message: `Subcategory "${subCategoryDoc.name}" is used in products and cannot be deleted`,
      });
    }

    await SubCategory.findByIdAndDelete(id);
    return res.status(200).json({ success: true, message: "Sub category deleted" });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

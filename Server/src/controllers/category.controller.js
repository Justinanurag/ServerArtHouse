import Category from "../models/category.model.js";
import Product from "../models/product.model.js";

//Get categories
export const getCategories = async (_req, res) => {
  try {
    let categories = await Category.find().sort({ name: 1 }).lean();

    if (!categories.length) {
      const distinctNames = await Product.distinct("category");

      categories = await Category.insertMany(
        distinctNames.map((name) => ({ name }))
      );
    }

    return res.status(200).json({ success: true, categories });
  } catch (error) {
    console.error("getCategories error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch categories" });
  }
};

//Add categories
export const addCategories = async (req, res) => {
  try {
    const { categories } = req.body;

    if (!categories || !Array.isArray(categories)) {
      return res.status(400).json({ success: false, message: "Invalid categories" });
    }

    const names = categories
      .map((c) => String(c?.name || "").trim())
      .filter(Boolean);

    if (!names.length) {
      return res.status(400).json({
        success: false,
        message: "At least one category name is required",
      });
    }

    const lowers = [
      ...new Set(names.map((n) => n.toLowerCase())),
    ];

    // Avoid giant $regex — MongoDB rejects patterns over ~16KB
    const existing = await Category.find({
      $expr: {
        $in: [{ $toLower: "$name" }, lowers],
      },
    })
      .select("name")
      .lean();

    const existingLower = new Set(
      existing.map((c) => String(c.name).trim().toLowerCase()),
    );

    const newCategories = names
      .filter((name) => !existingLower.has(name.toLowerCase()))
      .filter(
        (name, index, arr) =>
          arr.findIndex((n) => n.toLowerCase() === name.toLowerCase()) ===
          index,
      )
      .map((name) => ({ name }));

    const created = newCategories.length
      ? await Category.insertMany(newCategories)
      : [];

    return res.status(201).json({
      success: true,
      categories: created,
      existing,
    });
  } catch (error) {
    console.error("addCategories error:", error);
    return res.status(500).json({ success: false, message: "Failed to add categories" });
  }
};

//Update categories
export const updateCategories = async (req, res) => {
  try {
    const { categories } = req.body;

    const updates = await Promise.all(
      categories.map(async (cat) => {
        const oldCat = await Category.findById(cat._id);
        const updatedCat = await Category.findByIdAndUpdate(cat._id, { name: cat.name }, { new: true });
        
        if (oldCat && oldCat.name !== cat.name) {
          // Sync all products using the old category name to the new name
          await Product.updateMany({ category: oldCat.name }, { category: cat.name });
        }
        return updatedCat;
      })
    );

    return res.status(200).json({ success: true, categories: updates });
  } catch (error) {
    console.error("updateCategories error:", error);
    return res.status(500).json({ success: false, message: "Failed to update categories" });
  }
};

//Delete categories
export const deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;

    const categoryDoc = await Category.findById(id);
    if (!categoryDoc) {
      return res.status(404).json({ success: false, message: "Category not found" });
    }

    const isUsed = await Product.findOne({
      $or: [
        { category: id },
        { category: categoryDoc.name }
      ]
    });

    if (isUsed) {
      return res.status(400).json({
        success: false,
        message: `Category "${categoryDoc.name}" is used in products and cannot be deleted`,
      });
    }

    await Category.findByIdAndDelete(id);

    return res.status(200).json({
      success: true,
      message: "Category deleted",
    });
  } catch (error) {
    console.error("deleteCategory error:", error);
    return res.status(500).json({ success: false, message: "Failed to delete category" });
  }
};

import Company from "../models/company.model.js";
import User from "../models/auth.model.js";

export const createCompany = async (req, res) => {
  try {
    const { name, branch, logo, address, gstin, email, phone } = req.body;
    const userId = req.user?._id || req.body.userId; // Assuming auth middleware sets req.user

    if (!userId) {
        return res.status(401).json({ message: "User not authenticated" });
    }

    const company = new Company({
      name,
      branch,
      logo,
      address,
      gstin,
      email,
      phone,
      createdBy: userId,
    });

    await company.save();

    // Add company to user's list
    await User.findByIdAndUpdate(userId, {
      $push: { companies: company._id },
      $set: { activeCompany: company._id }
    });

    res.status(201).json({ message: "Company created successfully", company });
  } catch (error) {
    res.status(500).json({ message: "Error creating company", error: error.message });
  }
};

export const getMyCompanies = async (req, res) => {
  try {
    const userId = req.user?._id || req.query.userId;
    
    if (!userId) {
        return res.status(401).json({ message: "User not authenticated" });
    }

    const user = await User.findById(userId).populate("companies");
    res.status(200).json({ 
        companies: user.companies,
        activeCompany: user.activeCompany 
    });
  } catch (error) {
    res.status(500).json({ message: "Error fetching companies", error: error.message });
  }
};

export const switchActiveCompany = async (req, res) => {
  try {
    const { companyId } = req.body;
    const userId = req.user?._id || req.body.userId;

    if (!userId) {
        return res.status(401).json({ message: "User not authenticated" });
    }

    const user = await User.findById(userId);
    if (!user.companies.includes(companyId)) {
      return res.status(403).json({ message: "You do not have access to this company" });
    }

    user.activeCompany = companyId;
    await user.save();

    res.status(200).json({ message: "Active company switched successfully", activeCompanyId: companyId });
  } catch (error) {
    res.status(500).json({ message: "Error switching company", error: error.message });
  }
};

export const updateCompany = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = req.body;

    const company = await Company.findByIdAndUpdate(id, updateData, { new: true });
    res.status(200).json({ message: "Company updated successfully", company });
  } catch (error) {
    res.status(500).json({ message: "Error updating company", error: error.message });
  }
};

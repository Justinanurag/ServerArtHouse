import mongoose from "mongoose";
import ExpenceCategory from "../models/expenceCategory.model.js";

const getAllExpenceCategory = async (req, res) => {
    try {
        const expenceCategory = await ExpenceCategory.find().sort({ createdAt: -1 });
        res.status(200).json(expenceCategory);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const getExpenceCategoryById = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({success: false, message: 'Invalid expense category id.'});
        }
        const expenceCategory = await ExpenceCategory.findById(id);
        if (!expenceCategory) {
            return res.status(404).json({success: false, message: 'Expense category not found.'});
        }
        res.status(200).json(expenceCategory);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const addExpenceCategory = async (req, res) => {
    try {
        const expenceCategory = await ExpenceCategory.create(req.body);
        res.status(201).json(expenceCategory);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const updateExpenceCategory = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({success: false, message: 'Invalid expense category id.'});
        }
        const expenceCategory = await ExpenceCategory.findByIdAndUpdate(id, req.body, {
            new: true,
            runValidators: true,
        });
        if (!expenceCategory) {
            return res.status(404).json({success: false, message: 'Expense category not found.'});
        }
        res.status(200).json(expenceCategory);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

const deleteExpenceCategory = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({success: false, message: 'Invalid expense category id.'});
        }
        const expenceCategory = await ExpenceCategory.findByIdAndDelete(id);
        if (!expenceCategory) {
            return res.status(404).json({success: false, message: 'Expense category not found.'});
        }
        res.status(200).json(expenceCategory);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

export { getAllExpenceCategory, getExpenceCategoryById, addExpenceCategory, updateExpenceCategory, deleteExpenceCategory };
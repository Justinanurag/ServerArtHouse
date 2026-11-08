import mongoose from "mongoose";
import LeadLabel from "../models/leadLabel.model.js";
import Lead from "../models/lead.model.js";

const DEFAULTS = [
  { name: "Space Query", color: "#EAB308" },
  { name: "New Visitor", color: "#F97316" },
  { name: "Summer Camp 2026", color: "#D6C7A1" },
  { name: "Resin Supplies", color: "#22C55E" },
  { name: "Service", color: "#EC4899" },
  { name: "Crochet", color: "#EF4444" },
  { name: "Hiring Queries", color: "#A855F7" },
];

const HEX = /^#([0-9a-fA-F]{6})$/;

export const ensureDefaultLeadLabels = async () => {
  const count = await LeadLabel.estimatedDocumentCount();
  if (count > 0) return;
  await LeadLabel.insertMany(DEFAULTS, { ordered: false }).catch(() => {});
};

const cleanName = (value) => String(value || "").trim().replace(/\s+/g, " ");

const readColor = (value) => {
  const color = String(value || "").trim();
  return HEX.test(color) ? color.toUpperCase() : "";
};

export const listLeadLabels = async (_req, res) => {
  try {
    await ensureDefaultLeadLabels();
    const labels = await LeadLabel.find().sort({ name: 1 }).lean();
    return res.status(200).json({ success: true, labels });
  } catch (error) {
    console.error("listLeadLabels error:", error);
    return res.status(500).json({ success: false, message: "Failed to load labels." });
  }
};

export const createLeadLabel = async (req, res) => {
  try {
    const name = cleanName(req.body?.name);
    const color = readColor(req.body?.color);
    if (!name) return res.status(400).json({ success: false, message: "Label name is required." });
    if (!color) return res.status(400).json({ success: false, message: "Choose a valid label color." });
    const existing = await LeadLabel.findOne({ name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") });
    if (existing) return res.status(400).json({ success: false, message: "A label with this name already exists." });
    const label = await LeadLabel.create({ name, color });
    return res.status(201).json({ success: true, label });
  } catch (error) {
    console.error("createLeadLabel error:", error);
    return res.status(500).json({ success: false, message: "Failed to create label." });
  }
};

export const updateLeadLabel = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.labelId)) {
      return res.status(400).json({ success: false, message: "Invalid label id." });
    }
    const patch = {};
    if (req.body?.name !== undefined) {
      const name = cleanName(req.body.name);
      if (!name) return res.status(400).json({ success: false, message: "Label name is required." });
      const clash = await LeadLabel.findOne({
        _id: { $ne: req.params.labelId },
        name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
      });
      if (clash) return res.status(400).json({ success: false, message: "A label with this name already exists." });
      patch.name = name;
    }
    if (req.body?.color !== undefined) {
      const color = readColor(req.body.color);
      if (!color) return res.status(400).json({ success: false, message: "Choose a valid label color." });
      patch.color = color;
    }
    const label = await LeadLabel.findByIdAndUpdate(req.params.labelId, patch, { new: true }).lean();
    if (!label) return res.status(404).json({ success: false, message: "Label not found." });
    return res.status(200).json({ success: true, label });
  } catch (error) {
    console.error("updateLeadLabel error:", error);
    return res.status(500).json({ success: false, message: "Failed to update label." });
  }
};

export const deleteLeadLabel = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.labelId)) {
      return res.status(400).json({ success: false, message: "Invalid label id." });
    }
    const label = await LeadLabel.findByIdAndDelete(req.params.labelId).lean();
    if (!label) return res.status(404).json({ success: false, message: "Label not found." });
    await Lead.updateMany({ labelIds: label._id }, { $pull: { labelIds: label._id } });
    return res.status(200).json({ success: true, message: "Label deleted." });
  } catch (error) {
    console.error("deleteLeadLabel error:", error);
    return res.status(500).json({ success: false, message: "Failed to delete label." });
  }
};

export const normalizeLabelIds = async (value) => {
  const raw = Array.isArray(value) ? value : [];
  const ids = [...new Set(raw.map((id) => String(id || "").trim()).filter((id) => mongoose.Types.ObjectId.isValid(id)))];
  if (!ids.length) return [];
  const found = await LeadLabel.find({ _id: { $in: ids } }).select("_id").lean();
  return found.map((row) => row._id);
};

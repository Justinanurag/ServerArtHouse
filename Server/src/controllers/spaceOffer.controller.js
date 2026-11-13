import mongoose from "mongoose";
import SpaceOffer from "../models/spaceOffer.model.js";
import {
  normalizeOfferRules,
  offerMoney,
  quoteBookingOffer,
  validateOfferRules,
} from "../services/spaceOffer.service.js";

const escapeRegex = (value) => String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const readOffer = (body, {partial = false} = {}) => {
  const errors = [];
  const payload = {};
  if (!partial || body.offerName !== undefined) {
    const offerName = String(body.offerName || "").trim();
    if (!offerName) errors.push("Offer name is required.");
    else payload.offerName = offerName;
  }
  if (!partial || body.description !== undefined) {
    payload.description = String(body.description || "").trim();
  }
  payload.offerType = "space_booking";
  if (!partial || body.priority !== undefined) {
    const priority = Number(body.priority);
    payload.priority = Number.isFinite(priority) ? priority : 0;
  }
  if (!partial || body.status !== undefined) {
    const status = String(body.status || "active").trim().toLowerCase();
    if (!["active", "inactive"].includes(status)) errors.push("Status must be active or inactive.");
    else payload.status = status;
  }
  if (!partial || body.rules !== undefined) {
    const message = validateOfferRules(body.rules);
    if (message) errors.push(message);
    else payload.rules = normalizeOfferRules(body.rules);
  }
  return {payload, errors};
};

const loadActiveOffers = () =>
  SpaceOffer.find({status: "active", offerType: "space_booking"}).lean();

export const createSpaceOffer = async (req, res) => {
  try {
    const {payload, errors} = readOffer(req.body || {});
    if (errors.length) return res.status(400).json({success: false, message: errors[0]});
    const offer = await SpaceOffer.create(payload);
    return res.status(201).json({success: true, offer});
  } catch (error) {
    console.error("createSpaceOffer error:", error);
    return res.status(500).json({success: false, message: "Failed to create offer."});
  }
};

export const getSpaceOffers = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 10));
    const search = String(req.query.search || "").trim();
    const status = String(req.query.status || "all").trim().toLowerCase();
    const filter = {offerType: "space_booking"};
    if (status === "active" || status === "inactive") filter.status = status;
    if (search) filter.offerName = {$regex: escapeRegex(search), $options: "i"};
    const [offers, total] = await Promise.all([
      SpaceOffer.find(filter)
        .sort({createdAt: -1})
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      SpaceOffer.countDocuments(filter),
    ]);
    return res.status(200).json({
      success: true,
      offers,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    console.error("getSpaceOffers error:", error);
    return res.status(500).json({success: false, message: "Failed to load offers."});
  }
};

export const getSpaceOfferById = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({success: false, message: "Invalid offer id."});
    }
    const offer = await SpaceOffer.findById(req.params.id).lean();
    if (!offer) return res.status(404).json({success: false, message: "Offer not found."});
    return res.status(200).json({success: true, offer});
  } catch (error) {
    console.error("getSpaceOfferById error:", error);
    return res.status(500).json({success: false, message: "Failed to load offer."});
  }
};

export const updateSpaceOffer = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({success: false, message: "Invalid offer id."});
    }
    const {payload, errors} = readOffer(req.body || {});
    if (errors.length) return res.status(400).json({success: false, message: errors[0]});
    const offer = await SpaceOffer.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    }).lean();
    if (!offer) return res.status(404).json({success: false, message: "Offer not found."});
    return res.status(200).json({success: true, offer});
  } catch (error) {
    console.error("updateSpaceOffer error:", error);
    return res.status(500).json({success: false, message: "Failed to update offer."});
  }
};

export const setSpaceOfferStatus = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({success: false, message: "Invalid offer id."});
    }
    const status = String(req.body?.status || req.params.status || "").trim().toLowerCase();
    if (!["active", "inactive"].includes(status)) {
      return res.status(400).json({success: false, message: "Status must be active or inactive."});
    }
    const offer = await SpaceOffer.findByIdAndUpdate(
      req.params.id,
      {status},
      {new: true},
    ).lean();
    if (!offer) return res.status(404).json({success: false, message: "Offer not found."});
    return res.status(200).json({success: true, offer});
  } catch (error) {
    console.error("setSpaceOfferStatus error:", error);
    return res.status(500).json({success: false, message: "Failed to update offer status."});
  }
};

export const deleteSpaceOffer = async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({success: false, message: "Invalid offer id."});
    }
    const offer = await SpaceOffer.findByIdAndDelete(req.params.id).lean();
    if (!offer) return res.status(404).json({success: false, message: "Offer not found."});
    return res.status(200).json({success: true, message: "Offer deleted."});
  } catch (error) {
    console.error("deleteSpaceOffer error:", error);
    return res.status(500).json({success: false, message: "Failed to delete offer."});
  }
};

const linesFromBody = (body) => {
  if (Array.isArray(body?.lines) && body.lines.length) {
    return body.lines.map((line) => ({
      hourlyRate: offerMoney(line?.hourlyRate),
      qty: Math.max(1, Number(line?.qty) || 1),
    }));
  }
  return [{hourlyRate: offerMoney(body?.hourlyRate), qty: Math.max(1, Number(body?.qty) || 1)}];
};

export const getApplicableSpaceOffer = async (req, res) => {
  try {
    const source = req.method === "GET" ? req.query : req.body || {};
    const hours = offerMoney(source.hours ?? source.durationHours);
    if (!(hours > 0)) {
      return res.status(400).json({success: false, message: "Booking duration is required."});
    }
    const offers = await loadActiveOffers();
    const offer = quoteBookingOffer({offers, hours, lines: linesFromBody(source)});
    return res.status(200).json({success: true, offer});
  } catch (error) {
    console.error("getApplicableSpaceOffer error:", error);
    return res.status(500).json({success: false, message: "Failed to calculate the offer."});
  }
};

export const applyOfferToBookingPayload = async (payload, existing = null) => {
  const snapshot = payload.summarySnapshot || existing?.summarySnapshot || null;
  const dateMode = payload.dateMode || existing?.dateMode || "single";
  const isDuration = Boolean(snapshot?.isDurationPlan);
  const isMultiple = dateMode === "multiple";
  const start = payload.startTime || existing?.startTime;
  const end = payload.endTime || existing?.endTime;
  const minutes = (value) => {
    const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
  };
  const from = minutes(start);
  const to = minutes(end);
  const hours = from != null && to != null && to > from
    ? offerMoney((to - from) / 60)
    : offerMoney(payload.durationHours ?? existing?.durationHours ?? 0);

  const existingHours = (() => {
    const a = minutes(existing?.startTime);
    const b = minutes(existing?.endTime);
    if (a != null && b != null && b > a) return offerMoney((b - a) / 60);
    return offerMoney(existing?.durationHours || 0);
  })();
  const sameSpace = !payload.spaceId || String(payload.spaceId) === String(existing?.spaceId || "");
  const sameQty = payload.spaceQty == null || Number(payload.spaceQty) === Number(existing?.spaceQty || 1);
  const hoursUnchanged = existing && sameSpace && sameQty && Math.abs(hours - existingHours) < 0.001;

  if (isDuration || isMultiple) {
    payload.offerDiscount = 0;
    payload.offerSnapshot = null;
    return payload;
  }

  if (hoursUnchanged && existing) {
    const stored = offerMoney(existing.offerDiscount || 0);
    // A later payment update sends the payable total and often omits the offer.
    // Treating a missing offer as ₹0 subtracted the free-hour discount again.
    if (payload.offerDiscount !== undefined) {
      const client = offerMoney(payload.offerDiscount || 0);
      const delta = offerMoney(stored - client);
      if (payload.lineTotal != null) payload.lineTotal = offerMoney(Math.max(0, payload.lineTotal - delta));
      if (payload.grandTotal != null) payload.grandTotal = offerMoney(Math.max(0, payload.grandTotal - delta));
      if (payload.paidAmount != null && payload.grandTotal != null) {
        payload.dueAmount = offerMoney(Math.max(0, payload.grandTotal - payload.paidAmount));
      }
    }
    payload.offerDiscount = stored;
    payload.offerSnapshot = existing.offerSnapshot || null;
    return payload;
  }

  const lines = Array.isArray(snapshot?.selectedSpaces) && snapshot.selectedSpaces.length
    ? snapshot.selectedSpaces.map((space) => ({
        hourlyRate: space.unitPrice,
        qty: space.qty || payload.spaceQty || existing?.spaceQty || 1,
      }))
    : [{
        hourlyRate: payload.unitPrice ?? existing?.unitPrice ?? 0,
        qty: payload.spaceQty || existing?.spaceQty || 1,
      }];
  const offers = await loadActiveOffers();
  const quote = quoteBookingOffer({offers, hours, lines});
  const serverDiscount = offerMoney(quote.discount);
  const clientDiscount = offerMoney(payload.offerDiscount || 0);
  const delta = offerMoney(serverDiscount - clientDiscount);
  if (payload.lineTotal != null) payload.lineTotal = offerMoney(Math.max(0, payload.lineTotal - delta));
  if (payload.grandTotal != null) payload.grandTotal = offerMoney(Math.max(0, payload.grandTotal - delta));
  if (payload.paidAmount != null && payload.grandTotal != null) {
    payload.dueAmount = offerMoney(Math.max(0, payload.grandTotal - payload.paidAmount));
  }
  payload.offerDiscount = serverDiscount;
  payload.offerSnapshot = quote.applied
    ? {
        offerId: quote.offerId,
        offerName: quote.offerName,
        minimumHours: quote.minimumHours,
        freeHours: quote.freeHours,
        chargeableHours: quote.chargeableHours,
        originalAmount: quote.originalAmount,
        discount: quote.discount,
        finalAmount: quote.finalAmount,
      }
    : null;
  if (payload.summarySnapshot && typeof payload.summarySnapshot === "object") {
    payload.summarySnapshot = {
      ...payload.summarySnapshot,
      offer: payload.offerSnapshot,
      offerDiscount: serverDiscount,
      grandTotal: payload.grandTotal ?? payload.summarySnapshot.grandTotal,
    };
  }
  return payload;
};

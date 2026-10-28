import mongoose from 'mongoose';
import Coupon from '../models/coupon.model.js';
import Invoice from '../models/invoice.model.js';
import Customer from '../models/customer.model.js';

const normalizeCode = (value) => String(value ?? '').trim().toUpperCase();

const APPLICABLE_ON = new Set([
  'all',
  'store',
  'space',
  'service',
  'food',
  'membership',
]);

const normalizeApplicableOn = (raw) => {
  const list = Array.isArray(raw)
    ? raw.map((v) => String(v ?? '').trim().toLowerCase()).filter(Boolean)
    : [];
  const unique = [...new Set(list.filter((v) => APPLICABLE_ON.has(v)))];
  if (!unique.length || unique.includes('all')) return ['all'];
  return unique;
};

/** Map line category / sourceType → coupon applicableOn scope. */
export const mapLineToCouponScope = (raw) => {
  const lower = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!lower) return 'store';
  if (lower === 'food' || lower === 'foods') return 'food';
  if (lower === 'space' || lower === 'spaces' || lower === 'studio') return 'space';
  if (lower === 'service' || lower === 'services') return 'service';
  if (lower === 'membership' || lower === 'subscription') return 'membership';
  // product / store / general / catalogue → store (all products)
  return 'store';
};

export const scopesFromItems = (items = []) => {
  const set = new Set();
  for (const item of items) {
    const scope = mapLineToCouponScope(
      item?.lineCategory ||
        item?.sourceType ||
        item?.category ||
        item?.type ||
        item?.productCategory,
    );
    set.add(scope);
  }
  return [...set];
};

/**
 * Coupon is valid for this cart when:
 * - applicableOn includes "all", OR
 * - every cart scope is covered by the coupon scopes
 *   (e.g. food coupon only if cart is food-only; store coupon only for products)
 */
export const couponMatchesCartScopes = (couponApplicableOn, cartScopes = []) => {
  const scopes = normalizeApplicableOn(couponApplicableOn);
  if (scopes.includes('all')) return {ok: true};
  if (!cartScopes.length) {
    return {
      ok: false,
      message: 'This coupon requires a checkout section (store, space, service, food, or membership).',
    };
  }
  const uncovered = cartScopes.filter((s) => !scopes.includes(s));
  if (uncovered.length) {
    const allowed = scopes.join(', ');
    return {
      ok: false,
      message: `This coupon applies only to: ${allowed}. It cannot be used on this bill.`,
    };
  }
  return {ok: true};
};

const calculateCouponDiscount = ({ coupon, orderAmount }) => {
  const amount = Number(orderAmount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) return 0;

  if (coupon.discountType === 'flat') {
    return Math.min(amount, Number(coupon.discountValue ?? 0));
  }

  const raw = (amount * Number(coupon.discountValue ?? 0)) / 100;
  const maxCap = Number(coupon.maxDiscountAmount ?? 0);
  if (maxCap > 0) {
    return Math.min(raw, maxCap, amount);
  }
  return Math.min(raw, amount);
};

export const validateCouponForOrder = async ({
  code,
  orderAmount,
  customerPhone,
  ignoreInvoiceId = null,
  applicableContext = null,
  applicableContexts = null,
  items = null,
}) => {
  const normalizedCode = normalizeCode(code);
  if (!normalizedCode) {
    return { ok: false, message: 'Coupon code is required.' };
  }

  const amount = Number(orderAmount ?? 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, message: 'Order amount must be greater than 0.' };
  }

  const coupon = await Coupon.findOne({ code: normalizedCode });
  if (!coupon) return { ok: false, message: 'Coupon not found.' };
  if (!coupon.isActive) return { ok: false, message: 'Coupon is inactive.' };

  const now = new Date();
  if (coupon.startsAt && now < coupon.startsAt) {
    return { ok: false, message: 'Coupon is not active yet.' };
  }
  if (coupon.expiresAt && now > coupon.expiresAt) {
    return { ok: false, message: 'Coupon has expired.' };
  }

  // Resolve cart scopes: explicit list > single context > derive from items
  let cartScopes = [];
  if (Array.isArray(applicableContexts) && applicableContexts.length) {
    cartScopes = [
      ...new Set(
        applicableContexts
          .map((s) => mapLineToCouponScope(s))
          .filter((s) => APPLICABLE_ON.has(s) && s !== 'all'),
      ),
    ];
  } else if (applicableContext) {
    const mapped = mapLineToCouponScope(applicableContext);
    if (mapped !== 'all') cartScopes = [mapped];
  } else if (Array.isArray(items) && items.length) {
    cartScopes = scopesFromItems(items);
  }

  const scopeCheck = couponMatchesCartScopes(coupon.applicableOn, cartScopes);
  if (!scopeCheck.ok) {
    return { ok: false, message: scopeCheck.message };
  }

  const minOrder = Number(coupon.minOrderAmount ?? 0);
  if (amount < minOrder) {
    return {
      ok: false,
      message: `Minimum order amount for this coupon is ${minOrder}.`,
    };
  }

  if (
    Number.isFinite(Number(coupon.usageLimit)) &&
    Number(coupon.usageLimit) > 0 &&
    Number(coupon.usedCount ?? 0) >= Number(coupon.usageLimit)
  ) {
    return { ok: false, message: 'Coupon usage limit reached.' };
  }

  if (customerPhone && Number(coupon.perCustomerLimit ?? 0) > 0) {
    const phone = String(customerPhone).trim();
    const usageQuery = {
      customerPhone: phone,
      status: { $ne: 'cancelled' },
      'coupon.code': normalizedCode,
    };
    if (ignoreInvoiceId && mongoose.Types.ObjectId.isValid(String(ignoreInvoiceId))) {
      usageQuery._id = { $ne: String(ignoreInvoiceId) };
    }
    const invoiceUses = await Invoice.countDocuments(usageQuery);

    // Also count membership checkout redemptions stored on the customer profile
    const customerDoc = await Customer.findOne(
      { mobile: phone, isDeleted: { $ne: true } },
      { couponUsages: 1 },
    ).lean();
    const membershipUses = Array.isArray(customerDoc?.couponUsages)
      ? customerDoc.couponUsages.filter(
          u => String(u?.code || '').trim().toUpperCase() === normalizedCode,
        ).length
      : 0;

    if (invoiceUses + membershipUses >= Number(coupon.perCustomerLimit)) {
      return { ok: false, message: 'Coupon already used maximum times by this customer.' };
    }
  }

  const discountAmount = calculateCouponDiscount({ coupon, orderAmount: amount });
  if (discountAmount <= 0) {
    return { ok: false, message: 'Coupon is not applicable on this order.' };
  }

  return {
    ok: true,
    coupon,
    discountAmount,
    normalizedCode,
  };
};

export const createCoupon = async (req, res) => {
  try {
    const body = req.body ?? {};
    const code = normalizeCode(body.code);
    if (!code || !body.title || !body.discountType || body.discountValue === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Code, title, discount type and discount value are required.',
      });
    }
    if (!['percentage', 'flat'].includes(String(body.discountType))) {
      return res.status(400).json({
        success: false,
        message: "discountType must be 'percentage' or 'flat'.",
      });
    }

    const existing = await Coupon.findOne({ code });
    if (existing) {
      return res.status(409).json({ success: false, message: 'Coupon code already exists.' });
    }

    const expiresAt = new Date(body.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) {
      return res.status(400).json({ success: false, message: 'Valid expiry date is required.' });
    }
    const startsAt =
      body.startsAt !== undefined && body.startsAt !== null && String(body.startsAt).trim()
        ? new Date(body.startsAt)
        : null;
    if (startsAt && Number.isNaN(startsAt.getTime())) {
      return res.status(400).json({ success: false, message: 'Invalid start date.' });
    }
    if (startsAt && startsAt > expiresAt) {
      return res.status(400).json({
        success: false,
        message: 'Start date must be before expiry date.',
      });
    }

    const coupon = await Coupon.create({
      code,
      title: String(body.title).trim(),
      description: String(body.description ?? '').trim(),
      discountType: String(body.discountType),
      discountValue: Number(body.discountValue),
      minOrderAmount: Number(body.minOrderAmount ?? 0),
      maxDiscountAmount:
        body.maxDiscountAmount === null || body.maxDiscountAmount === undefined
          ? null
          : Number(body.maxDiscountAmount),
      startsAt,
      expiresAt,
      usageLimit:
        body.usageLimit === null ||
        body.usageLimit === undefined ||
        Number(body.usageLimit) <= 0
          ? null
          : Number(body.usageLimit),
      perCustomerLimit:
        body.perCustomerLimit === null ||
        body.perCustomerLimit === undefined ||
        Number(body.perCustomerLimit) <= 0
          ? null
          : Number(body.perCustomerLimit),
      applicableOn: normalizeApplicableOn(body.applicableOn),
      isActive: Boolean(body.isActive ?? true),
      createdBy: body.createdBy ?? undefined,
    });

    return res.status(201).json({
      success: true,
      message: 'Coupon created successfully.',
      coupon,
    });
  } catch (error) {
    console.error('createCoupon error:', error);
    return res.status(500).json({ success: false, message: 'Failed to create coupon.' });
  }
};

export const getCoupons = async (req, res) => {
  try {
    const { search = '', status = 'all' } = req.query;
    const query = {};
    const s = String(search).trim();
    if (s) {
      query.$or = [
        { code: { $regex: s, $options: 'i' } },
        { title: { $regex: s, $options: 'i' } },
      ];
    }
    if (String(status).toLowerCase() === 'active') query.isActive = true;
    if (String(status).toLowerCase() === 'inactive') query.isActive = false;

    const coupons = await Coupon.find(query).sort({ createdAt: -1 });
    return res.status(200).json({
      success: true,
      message: 'Coupons fetched successfully.',
      coupons,
    });
  } catch (error) {
    console.error('getCoupons error:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch coupons.' });
  }
};

export const updateCoupon = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid coupon id.' });
    }
    const body = req.body ?? {};
    const patch = {};

    if (body.code !== undefined) patch.code = normalizeCode(body.code);
    if (body.title !== undefined) patch.title = String(body.title).trim();
    if (body.description !== undefined) patch.description = String(body.description ?? '').trim();
    if (body.discountType !== undefined) patch.discountType = String(body.discountType);
    if (body.discountValue !== undefined) patch.discountValue = Number(body.discountValue);
    if (body.minOrderAmount !== undefined) patch.minOrderAmount = Number(body.minOrderAmount);
    if (body.maxDiscountAmount !== undefined) {
      patch.maxDiscountAmount =
        body.maxDiscountAmount === null ? null : Number(body.maxDiscountAmount);
    }
    if (body.startsAt !== undefined) {
      patch.startsAt = body.startsAt ? new Date(body.startsAt) : null;
    }
    if (body.expiresAt !== undefined) patch.expiresAt = new Date(body.expiresAt);
    if (body.usageLimit !== undefined) {
      patch.usageLimit =
        body.usageLimit === null || Number(body.usageLimit) <= 0
          ? null
          : Number(body.usageLimit);
    }
    if (body.perCustomerLimit !== undefined) {
      patch.perCustomerLimit =
        body.perCustomerLimit === null || Number(body.perCustomerLimit) <= 0
          ? null
          : Number(body.perCustomerLimit);
    }
    if (body.applicableOn !== undefined) {
      patch.applicableOn = normalizeApplicableOn(body.applicableOn);
    }
    if (body.isActive !== undefined) patch.isActive = Boolean(body.isActive);

    if (patch.code) {
      const duplicate = await Coupon.findOne({ code: patch.code, _id: { $ne: id } });
      if (duplicate) {
        return res.status(409).json({ success: false, message: 'Coupon code already exists.' });
      }
    }

    const coupon = await Coupon.findByIdAndUpdate(id, patch, {
      new: true,
      runValidators: true,
    });
    if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found.' });
    return res.status(200).json({
      success: true,
      message: 'Coupon updated successfully.',
      coupon,
    });
  } catch (error) {
    console.error('updateCoupon error:', error);
    return res.status(500).json({ success: false, message: 'Failed to update coupon.' });
  }
};

export const deleteCoupon = async (req, res) => {
  try {
    const { id } = req.params;
    const coupon = await Coupon.findByIdAndDelete(id);
    if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found.' });
    return res.status(200).json({
      success: true,
      message: 'Coupon deleted successfully.',
    });
  } catch (error) {
    console.error('deleteCoupon error:', error);
    return res.status(500).json({ success: false, message: 'Failed to delete coupon.' });
  }
};

export const activateCoupon = async (req, res) => {
  try {
    const { id } = req.params;
    const coupon = await Coupon.findByIdAndUpdate(id, { isActive: true }, { new: true });
    if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found.' });
    return res.status(200).json({
      success: true,
      message: 'Coupon activated successfully.',
      coupon,
    });
  } catch (error) {
    console.error('activateCoupon error:', error);
    return res.status(500).json({ success: false, message: 'Failed to activate coupon.' });
  }
};

export const deactivateCoupon = async (req, res) => {
  try {
    const { id } = req.params;
    const coupon = await Coupon.findByIdAndUpdate(id, { isActive: false }, { new: true });
    if (!coupon) return res.status(404).json({ success: false, message: 'Coupon not found.' });
    return res.status(200).json({
      success: true,
      message: 'Coupon deactivated successfully.',
      coupon,
    });
  } catch (error) {
    console.error('deactivateCoupon error:', error);
    return res.status(500).json({ success: false, message: 'Failed to deactivate coupon.' });
  }
};

export const validateCoupon = async (req, res) => {
  try {
    const {
      code,
      orderAmount,
      customerPhone,
      applicableContext,
      applicableContexts,
      items,
    } = req.body ?? {};
    const result = await validateCouponForOrder({
      code,
      orderAmount,
      customerPhone,
      applicableContext,
      applicableContexts,
      items,
    });
    if (!result.ok) {
      return res.status(400).json({ success: false, message: result.message });
    }
    return res.status(200).json({
      success: true,
      message: 'Coupon is valid.',
      coupon: {
        code: result.coupon.code,
        title: result.coupon.title,
        discountType: result.coupon.discountType,
        discountValue: result.coupon.discountValue,
        applicableOn: normalizeApplicableOn(result.coupon.applicableOn),
      },
      discountAmount: result.discountAmount,
    });
  } catch (error) {
    console.error('validateCoupon error:', error);
    return res.status(500).json({ success: false, message: 'Failed to validate coupon.' });
  }
};

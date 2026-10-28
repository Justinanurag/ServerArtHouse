import mongoose from 'mongoose';
import Membership from '../models/membership.model.js';

/** Mongoose Map → plain object so clients always get Food/Space % keys */
const toPlainUsageLimits = (usageLimits) => {
  if (!usageLimits) return {};
  if (usageLimits instanceof Map) {
    return Object.fromEntries(usageLimits.entries());
  }
  if (typeof usageLimits?.toJSON === 'function') {
    const json = usageLimits.toJSON();
    if (json && typeof json === 'object') return json;
  }
  if (typeof usageLimits === 'object') return { ...usageLimits };
  return {};
};

/** Normalize plan pricing: grossAmount = original list, amount = selling (after discount). */
const normalizePricing = (pricing = {}) => {
  const period = String(pricing?.period ?? 'Monthly').trim();
  const taxPercent = Number(pricing?.taxPercent ?? 0);
  const discountType = String(pricing?.discountType ?? 'Percentage').trim();
  const discountPercent = Number(pricing?.discountPercent ?? 0);

  const hasGross =
    pricing?.grossAmount !== undefined &&
    pricing?.grossAmount !== null &&
    Number.isFinite(Number(pricing.grossAmount)) &&
    Number(pricing.grossAmount) > 0;

  // Original list / MRP
  const grossAmount = Math.max(
    0,
    Number(hasGross ? pricing.grossAmount : pricing?.amount ?? 0) || 0,
  );

  const discountAmount =
    String(discountType).toLowerCase() === 'flat'
      ? discountPercent
      : (grossAmount * discountPercent) / 100;

  // Selling price = net after discount (what customer pays)
  const amount = Math.max(0, grossAmount - discountAmount);

  return {
    period,
    grossAmount,
    amount,
    taxPercent,
    discountType,
    discountPercent,
  };
};

const serializeMembership = (doc) => {
  const plain =
    typeof doc?.toObject === 'function'
      ? doc.toObject({ flattenMaps: true })
      : { ...(doc || {}) };
  plain.usageLimits = toPlainUsageLimits(
    plain.usageLimits ?? doc?.usageLimits,
  );
  if (plain.pricing && typeof plain.pricing === 'object') {
    const normalized = normalizePricing(plain.pricing);
    plain.pricing = normalized;
  }
  plain.walletCashback = normalizeWalletCashback(plain.walletCashback);

  // Backfill Products cashback display field from usageLimits when missing
  const display = plain.customerDisplay || {};
  const productsLimit =
    plain.usageLimits?.Products ||
    plain.usageLimits?.products ||
    plain.usageLimits?.Product;
  const storeCashbackFromUsage = Number(productsLimit?.cashback ?? 0) || 0;
  plain.customerDisplay = {
    ...display,
    storeCashbackPercent:
      Number(display.storeCashbackPercent ?? 0) || storeCashbackFromUsage || 0,
  };

  return plain;
};

const normalizeCustomerDisplay = (input = {}) => ({
  showInApp: input.showInApp !== false,
  badgeLabel: String(input.badgeLabel ?? '').trim(),
  themeKey: String(input.themeKey ?? 'blue').trim(),
  iconKey: String(input.iconKey ?? 'user').trim(),
  cashbackPercent: Math.max(0, Number(input.cashbackPercent ?? 0)),
  /** Products / store cashback % (mirrors usageLimits.Products.cashback) */
  storeCashbackPercent: Math.max(0, Number(input.storeCashbackPercent ?? 0)),
  storeDiscountPercent: Math.max(0, Number(input.storeDiscountPercent ?? 0)),
  spaceDiscountPercent: Math.max(0, Number(input.spaceDiscountPercent ?? 0)),
  foodDiscountPercent: Math.max(0, Number(input.foodDiscountPercent ?? 0)),
  serviceDiscountPercent: Math.max(0, Number(input.serviceDiscountPercent ?? 0)),
  features: Array.isArray(input.features)
    ? input.features
        .map(item => ({
          label: String(item?.label ?? '').trim(),
          was: Math.max(0, Number(item?.was ?? 0)),
        }))
        .filter(item => item.label)
    : [],
});

const normalizeWalletCashback = (input = {}) => ({
  amount: Math.max(0, Number(input?.amount ?? 0) || 0),
});

export const createMembership = async (req, res) => {
  try {
    const {
      planId,
      displayName,
      priority,
      planType,
      description,
      pricing,
      usageLimits,
      insightsLevel,
      status,
      internalNotes,
      customerDisplay,
      walletCashback,
      createdBy,
    } = req.body;

    if (!planId || !displayName) {
      return res.status(400).json({
        success: false,
        message: 'Plan ID and Display Name are required.',
      });
    }

    const normalizedPlanId = String(planId).trim();
    const existing = await Membership.findOne({ planId: normalizedPlanId });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'Plan ID already exists.',
      });
    }

    const display = normalizeCustomerDisplay(customerDisplay);
    const walletCb = normalizeWalletCashback(walletCashback);

    const membership = await Membership.create({
      planId: normalizedPlanId,
      displayName: String(displayName).trim(),
      priority: Number(priority ?? 0),
      planType: String(planType ?? 'Professional').trim(),
      description: String(description ?? '').trim(),
      pricing: normalizePricing(pricing),
      usageLimits: usageLimits ?? undefined,
      insightsLevel: String(insightsLevel ?? 'Basic').trim(),
      status: String(status ?? 'Active').trim(),
      internalNotes: String(internalNotes ?? '').trim(),
      customerDisplay: display,
      walletCashback: walletCb,
      createdBy: createdBy ?? undefined,
    });

    return res.status(201).json({
      success: true,
      message: 'Membership created successfully.',
      membership: serializeMembership(membership),
    });
  } catch (error) {
    console.error('createMembership error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to create membership.',
    });
  }
};

export const getMemberships = async (req, res) => {
  try {
    const {
      search = '',
      planType,
      status,
      fromDate,
      toDate,
    } = req.query;

    const query = {};
    const dateFilter = {};

    const limit = Math.min(
      Math.max(Number(req.query.limit) || 2000, 1),
      5000
    );

    // Date filter
    if (fromDate) {
      const from = new Date(`${fromDate}T00:00:00.000`);

      if (!Number.isNaN(from.getTime())) {
        dateFilter.$gte = from;
      }
    }

    if (toDate) {
      const to = new Date(`${toDate}T23:59:59.999`);

      if (!Number.isNaN(to.getTime())) {
        dateFilter.$lte = to;
      }
    }

    if (Object.keys(dateFilter).length) {
      query.createdAt = dateFilter;
    }

    // Plan type filter
    if (
      planType &&
      String(planType).trim() &&
      String(planType) !== 'All'
    ) {
      query.planType = String(planType).trim();
    }

    // Status filter
    if (
      status &&
      String(status).trim() &&
      String(status) !== 'All'
    ) {
      query.status = String(status).trim();
    }

    // Search filter
    const s = String(search).trim();

    if (s) {
      query.$or = [
        {
          planId: {
            $regex: s,
            $options: 'i',
          },
        },
        {
          displayName: {
            $regex: s,
            $options: 'i',
          },
        },
      ];
    }

    const memberships = await Membership.find(query)
      .sort({
        priority: 1,
        createdAt: -1,
      })
      .limit(limit)
      .lean();

    return res.status(200).json({
      success: true,
      message: 'Memberships fetched successfully.',
      memberships: memberships.map(serializeMembership),
    });
  } catch (error) {
    console.error('getMemberships error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch memberships.',
    });
  }
};

export const updateMembership = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid membership id.',
      });
    }

    const body = req.body ?? {};
    const patch = {};

    if (body.planId !== undefined) patch.planId = String(body.planId).trim();
    if (body.displayName !== undefined) patch.displayName = String(body.displayName).trim();
    if (body.priority !== undefined) patch.priority = Number(body.priority ?? 0);
    if (body.planType !== undefined) patch.planType = String(body.planType ?? '').trim();
    if (body.description !== undefined) patch.description = String(body.description ?? '').trim();
    if (body.insightsLevel !== undefined) patch.insightsLevel = String(body.insightsLevel ?? '').trim();
    if (body.status !== undefined) patch.status = String(body.status ?? '').trim();
    if (body.internalNotes !== undefined) patch.internalNotes = String(body.internalNotes ?? '').trim();
    if (body.createdBy !== undefined) patch.createdBy = body.createdBy;
    if (body.usageLimits !== undefined) patch.usageLimits = body.usageLimits;
    if (body.customerDisplay !== undefined) {
      patch.customerDisplay = normalizeCustomerDisplay(body.customerDisplay);
    }
    if (body.pricing !== undefined) {
      patch.pricing = normalizePricing(body.pricing);
    }
    if (body.walletCashback !== undefined) {
      patch.walletCashback = normalizeWalletCashback(body.walletCashback);
    }

    if (patch.planId) {
      const exists = await Membership.findOne({
        planId: patch.planId,
        _id: { $ne: id },
      });
      if (exists) {
        return res.status(409).json({
          success: false,
          message: 'Plan ID already exists.',
        });
      }
    }

    const membership = await Membership.findByIdAndUpdate(id, patch, {
      new: true,
      runValidators: true,
    });

    if (!membership) {
      return res.status(404).json({
        success: false,
        message: 'Membership not found.',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Membership updated successfully.',
      membership: serializeMembership(membership),
    });
  } catch (error) {
    console.error('updateMembership error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update membership.',
    });
  }
};

export const deleteMembership = async (req, res) => {
  try {
    const { id } = req.params;
    const membership = await Membership.findByIdAndDelete(id);
    if (!membership) {
      return res.status(404).json({
        success: false,
        message: 'Membership not found.',
      });
    }
    return res.status(200).json({
      success: true,
      message: 'Membership deleted successfully.',
    });
  } catch (error) {
    console.error('deleteMembership error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete membership.',
    });
  }
};
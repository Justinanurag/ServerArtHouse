import Customer from '../../../models/customer.model.js';
import Wallet from '../../../models/wallet.model.js';
import AffiliateSettings, {
  normalizeAffiliateRules,
} from '../../../models/affiliateSettings.model.js';
import AffiliateCommission from '../../../models/affiliateCommission.model.js';
import CommissionLedger from '../../../models/commissionLedger.model.js';
import {
  persistableBucketFields,
  resolveTwoBuckets,
} from '../../../utils/walletBuckets.js';

const generateReferralCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `W${code}`;
};

const ensureReferralCode = async customer => {
  if (customer.referralCode) return customer;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    customer.referralCode = generateReferralCode();
    try {
      await customer.save();
      return customer;
    } catch (error) {
      if (error?.code !== 11000) throw error;
      customer.referralCode = undefined;
    }
  }

  throw new Error('Could not generate a unique referral code');
};

const ensureAffiliateSettings = async () => {
  let settings = await AffiliateSettings.findOne({key: 'default'});
  if (!settings) {
    settings = await AffiliateSettings.create({key: 'default'});
  }

  const normalizedRules = normalizeAffiliateRules(settings.rules);
  const before = JSON.stringify(
    (settings.rules || []).map(rule =>
      typeof rule.toObject === 'function' ? rule.toObject() : rule,
    ),
  );
  const after = JSON.stringify(normalizedRules);
  if (before !== after) {
    settings.rules = normalizedRules;
    settings.markModified('rules');
    await settings.save();
  }

  return settings;
};

const calculateSignupBonusAmount = rule =>
  Math.max(0, Math.round(Number(rule?.commissionValue || 0) * 100) / 100);

const ensureInviteBalanceCredited = async (commission, inviterId) => {
  if (!commission) return commission;

  // Only repair commissions created with the new explicit flag.
  // Legacy records without the flag are assumed already balanced.
  if (commission.meta?.balanceCredited !== false) {
    return commission;
  }

  const amount = Number(commission.commissionAmount || 0);
  if (amount > 0 && inviterId) {
    const inviter = await Customer.findById(inviterId);
    if (inviter) {
      const seed = resolveTwoBuckets(null, inviter);
      let wallet = await Wallet.findOne({customerId: inviter._id});
      if (!wallet) {
        wallet = await Wallet.create({
          customerId: inviter._id,
          customerName: String(inviter.name ?? '').trim(),
          customerPhone: String(inviter.mobile ?? '').trim(),
          ...persistableBucketFields(seed),
          transactions: [],
        });
      }
      const {appendTransaction} = await import(
        '../../../controllers/wallet.controller.js'
      );
      await appendTransaction(wallet, {
        type: 'credit',
        amount,
        note: commission.description || 'Referral / invite earning',
        referenceType: 'Referral',
        referenceId: String(commission._id),
        walletType: 'withdrawable',
        createdBy: {
          m_staff_id: null,
          m_staff_name: 'System',
          m_staff_email: null,
        },
      });
    }
  }

  commission.meta = {
    ...(typeof commission.meta?.toObject === 'function'
      ? commission.meta.toObject()
      : commission.meta || {}),
    balanceCredited: true,
  };
  if (typeof commission.save === 'function') {
    commission.markModified?.('meta');
    await commission.save();
  } else {
    await AffiliateCommission.updateOne(
      {_id: commission._id},
      {$set: {'meta.balanceCredited': true}},
    );
  }

  return commission;
};

const ALLOWED_PURCHASE_CATEGORIES = new Set([
  'product',
  'space',
  'food',
  'service',
  'membership',
  'other',
]);

const normalizePurchaseCategory = raw => {
  const value = String(raw || '')
    .trim()
    .toLowerCase();
  if (ALLOWED_PURCHASE_CATEGORIES.has(value)) return value;
  return 'other';
};

const creditOneReferralCommission = async ({
  inviterId,
  referredCustomerId,
  category,
  sourceType,
  sourceId,
  orderAmount,
  commissionType,
  commissionValue,
  commissionAmount,
  description,
}) => {
  const amount = Math.max(0, Math.round(Number(commissionAmount || 0) * 100) / 100);
  if (!inviterId || !referredCustomerId || amount <= 0) return null;

  const safeCategory = normalizePurchaseCategory(category);
  const idempotencyKey = `referral-discount:${sourceType}:${sourceId}:${safeCategory}`;
  const existing = await AffiliateCommission.findOne({idempotencyKey});
  if (existing) {
    return ensureInviteBalanceCredited(existing, inviterId);
  }

  try {
    const commission = await AffiliateCommission.create({
      inviter: inviterId,
      referredCustomer: referredCustomerId,
      category: safeCategory,
      sourceType: String(sourceType || 'purchase'),
      sourceId: String(sourceId || ''),
      orderAmount: Math.max(0, Number(orderAmount || 0)),
      commissionType:
        commissionType === 'fixed' || commissionType === 'percentage'
          ? commissionType
          : 'percentage',
      commissionValue: Math.max(0, Number(commissionValue || 0)),
      commissionAmount: amount,
      status: 'credited',
      idempotencyKey,
      description:
        description ||
        `Referral commission (${safeCategory}) for ${sourceType} ${sourceId}`,
      approvedAt: new Date(),
      creditedAt: new Date(),
      meta: {
        balanceCredited: false,
        kind: 'referral_discount',
      },
    });

    return ensureInviteBalanceCredited(commission, inviterId);
  } catch (error) {
    if (error?.code === 11000) {
      const existingCommission = await AffiliateCommission.findOne({
        idempotencyKey,
      });
      return ensureInviteBalanceCredited(existingCommission, inviterId);
    }
    throw error;
  }
};

/**
 * Credit the inviter's affiliateBalance with the same amount given as
 * referral discount to the referred buyer at checkout (all segments).
 */
export const creditReferralDiscountToInviter = async ({
  inviterId,
  referredCustomerId,
  sourceType,
  sourceId,
  orderAmount,
  commissionAmount,
  commissionType,
  commissionValue,
  category,
  segments,
  buyerName,
}) => {
  if (!inviterId || !referredCustomerId) return [];

  const settings = await ensureAffiliateSettings();
  if (settings.isEnabled === false) return [];

  if (String(inviterId) === String(referredCustomerId)) return [];

  const credited = [];
  const segmentList = Array.isArray(segments)
    ? segments.filter(
        segment =>
          Number(segment?.commissionAmount || segment?.discountAmount || 0) > 0,
      )
    : [];

  if (segmentList.length > 0) {
    for (const segment of segmentList) {
      const row = await creditOneReferralCommission({
        inviterId,
        referredCustomerId,
        category: segment.category,
        sourceType,
        sourceId,
        orderAmount: Number(segment.lineAmount || orderAmount || 0),
        commissionType: segment.commissionType,
        commissionValue: segment.commissionValue,
        commissionAmount: Number(
          segment.commissionAmount ?? segment.discountAmount ?? 0,
        ),
        description: `Referral commission (${
          segment.label || segment.category
        }) · ${buyerName || 'referred customer'} · ${sourceType} ${sourceId}`,
      });
      if (row) credited.push(row);
    }
    return credited;
  }

  const row = await creditOneReferralCommission({
    inviterId,
    referredCustomerId,
    category: category || 'other',
    sourceType,
    sourceId,
    orderAmount,
    commissionType,
    commissionValue,
    commissionAmount,
    description: `Referral discount credited for ${
      buyerName || 'referred customer'
    } · ${sourceType} ${sourceId}`,
  });
  if (row) credited.push(row);
  return credited;
};

/**
 * Mark buyer account so referral checkout discount cannot be applied again.
 */
export const markReferralDiscountUsed = async ({
  customerId,
  sourceId,
}) => {
  if (!customerId) return null;

  return Customer.findOneAndUpdate(
    {_id: customerId, referralDiscountUsed: {$ne: true}},
    {
      $set: {
        referralDiscountUsed: true,
        referralDiscountUsedAt: new Date(),
        referralDiscountSourceId: String(sourceId || ''),
      },
    },
    {new: true},
  );
};

export const creditInviteReward = async ({
  referredCustomerId,
  orderAmount,
  paidAmount = orderAmount,
  sourceId,
  eventTrigger,
}) => {
  const referredCustomer = await Customer.findById(referredCustomerId);
  if (!referredCustomer?.referredBy) {
    return null;
  }

  const settings = await ensureAffiliateSettings();
  const inviteRule = settings.rules?.find(rule => rule.category === 'invite');
  if (settings.isEnabled === false || !inviteRule || inviteRule.enabled === false) {
    return null;
  }

  // Signup bonus only. Legacy purchase-based triggers are ignored.
  const configuredTrigger = 'registration';
  if (eventTrigger !== configuredTrigger) return null;

  // Always use the configured fixed amount (percentage of ₹0 would never pay).
  const commissionAmount = calculateSignupBonusAmount(inviteRule);
  if (commissionAmount <= 0) return null;

  const idempotencyKey = `invite:${configuredTrigger}:${referredCustomer._id}`;
  const existing = await AffiliateCommission.findOne({idempotencyKey});
  if (existing) {
    if (!referredCustomer.inviteRewardCredited) {
      referredCustomer.inviteRewardCredited = true;
      await referredCustomer.save();
    }
    return ensureInviteBalanceCredited(existing, referredCustomer.referredBy);
  }

  if (referredCustomer.inviteRewardCredited) {
    return null;
  }

  const claimed = await Customer.findOneAndUpdate(
    {_id: referredCustomer._id, inviteRewardCredited: {$ne: true}},
    {$set: {inviteRewardCredited: true}},
    {new: true},
  );
  if (!claimed) return null;

  try {
    const commission = await AffiliateCommission.create({
      inviter: referredCustomer.referredBy,
      referredCustomer: referredCustomer._id,
      category: 'invite',
      sourceType: eventTrigger,
      sourceId: String(sourceId || referredCustomer._id),
      orderAmount: Number(orderAmount || 0),
      commissionType: 'fixed',
      commissionValue: Number(inviteRule.commissionValue || 0),
      commissionAmount,
      status: 'credited',
      idempotencyKey,
      description: `Signup bonus for ${referredCustomer.name || 'referred customer'}`,
      approvedAt: new Date(),
      creditedAt: new Date(),
      meta: {balanceCredited: false},
    });

    return ensureInviteBalanceCredited(commission, referredCustomer.referredBy);
  } catch (error) {
    if (error?.code === 11000) {
      await Customer.updateOne(
        {_id: referredCustomer._id},
        {$set: {inviteRewardCredited: true}},
      );
      const existingCommission = await AffiliateCommission.findOne({
        idempotencyKey,
      });
      return ensureInviteBalanceCredited(
        existingCommission,
        referredCustomer.referredBy,
      );
    }
    await Customer.updateOne(
      {_id: referredCustomer._id},
      {$set: {inviteRewardCredited: false}},
    );
    throw error;
  }
};

export const getReferralDashboard = async (customerId, appBaseUrl) => {
  const customer = await Customer.findById(customerId);
  if (!customer || customer.isDeleted) {
    const error = new Error('Customer not found');
    error.status = 404;
    throw error;
  }

  await ensureReferralCode(customer);

  const settings = await ensureAffiliateSettings();
  const inviteRule =
    settings.rules?.find(r => r.category === 'invite') || {
      enabled: true,
      commissionType: 'fixed',
      commissionValue: 100,
    };

  const [totalReferrals, activeReferrals] = await Promise.all([
    Customer.countDocuments({
      referredBy: customer._id,
      isDeleted: {$ne: true},
    }),
    Customer.countDocuments({
      referredBy: customer._id,
      isDeleted: {$ne: true},
      status: 'active',
      membershipType: {$ne: 'none'},
    }),
  ]);

  const recentReferrals = await Customer.find({
    referredBy: customer._id,
    isDeleted: {$ne: true},
  })
    .select('name createdAt membershipType status')
    .sort({createdAt: -1})
    .limit(10);

  const [commissionSummary, legacySummary, referralEarnings] = await Promise.all([
    AffiliateCommission.aggregate([
      {$match: {inviter: customer._id}},
      {
        $group: {
          _id: '$status',
          amount: {$sum: '$commissionAmount'},
          count: {$sum: 1},
        },
      },
    ]),
    CommissionLedger.aggregate([
      {$match: {affiliateId: customer._id}},
      {
        $group: {
          _id: '$status',
          amount: {$sum: '$commissionAmount'},
          count: {$sum: 1},
        },
      },
    ]),
    AffiliateCommission.aggregate([
      {$match: {inviter: customer._id}},
      {
        $group: {
          _id: '$referredCustomer',
          totalEarned: {
            $sum: {
              $cond: [
                {$in: ['$status', ['approved', 'credited']]},
                '$commissionAmount',
                0,
              ],
            },
          },
          pendingEarnings: {
            $sum: {
              $cond: [{$eq: ['$status', 'pending']}, '$commissionAmount', 0],
            },
          },
        },
      },
    ]),
  ]);

  const primaryCount = commissionSummary.reduce(
    (sum, row) => sum + Number(row.count || 0),
    0,
  );
  const summary = primaryCount > 0 ? commissionSummary : legacySummary;
  const earnedStatuses =
    primaryCount > 0 ? ['approved', 'credited'] : ['Approved', 'Paid'];
  const pendingStatuses = primaryCount > 0 ? ['pending'] : ['Hold'];
  const earned = summary
    .filter(row => earnedStatuses.includes(row._id))
    .reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const pending = summary
    .filter(row => pendingStatuses.includes(row._id))
    .reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const transactions = summary.reduce(
    (sum, row) => sum + Number(row.count || 0),
    0,
  );
  const earningsByReferral = new Map(
    referralEarnings.map(row => [String(row._id), row]),
  );

  const recentReferralsWithEarnings = recentReferrals.map(referral => {
    const referralSummary = earningsByReferral.get(String(referral._id));
    return {
      id: referral._id,
      name: referral.name,
      membershipType: referral.membershipType,
      status: referral.status,
      joinedAt: referral.createdAt,
      totalEarned: referralSummary?.totalEarned || 0,
      pendingEarnings: referralSummary?.pendingEarnings || 0,
    };
  });

  const base = String(appBaseUrl || process.env.CUSTOMER_APP_URL || 'https://woowooarthouse.in').replace(
    /\/$/,
    '',
  );
  const referralCode = customer.referralCode;
  const shareUrl = `${base}/login?ref=${encodeURIComponent(referralCode)}`;
  const shareMessage = `Join me on WOOWOO Art House! Use my invite code ${referralCode} and start your creative journey. ${shareUrl}`;

  return {
    programEnabled: settings.isEnabled !== false,
    referralCode,
    shareUrl,
    shareMessage,
    inviteReward: {
      enabled: inviteRule.enabled !== false,
      type: inviteRule.commissionType || 'fixed',
      value: inviteRule.commissionValue || 0,
    },
    wallet: {
      affiliateBalance: customer.affiliateBalance || 0,
      affiliateReserved: customer.affiliateReserved || 0,
      cashbackBalance: customer.cashbackBalance || 0,
    },
    stats: {
      totalReferrals,
      activeReferrals,
      totalEarned: earned,
      pendingEarnings: pending,
      totalTransactions: transactions,
      totalOrders: transactions,
    },
    recentReferrals: recentReferralsWithEarnings,
  };
};

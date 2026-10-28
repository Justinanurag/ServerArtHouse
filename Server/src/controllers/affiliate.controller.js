import AffiliateSettings, {
  normalizeAffiliateRules,
} from '../models/affiliateSettings.model.js';
import Customer from '../models/customer.model.js';
import AffiliateCommission from '../models/affiliateCommission.model.js';
import PayoutRequest from '../models/payoutRequest.model.js';
import CommissionLedger from '../models/commissionLedger.model.js';
import WalletWithdrawal from '../models/walletWithdrawal.model.js';
import Invoice from '../models/invoice.model.js';
import Subscription from '../models/subscription.model.js';
import mongoose from 'mongoose';
import Wallet from '../models/wallet.model.js';
import {
  persistableBucketFields,
  resolveTwoBuckets,
} from '../utils/walletBuckets.js';

/** After affiliateBalance mutations, keep withdrawable aliases + wallet ledger aligned. */
const persistWithdrawableFromAffiliate = async (customer) => {
  if (!customer?._id) return;
  const wallet = await Wallet.findOne({customerId: customer._id});
  const current = resolveTwoBuckets(wallet, customer);
  const fields = persistableBucketFields({
    withdrawable: Math.max(0, Number(customer.affiliateBalance) || 0),
    nonWithdrawable: current.nonWithdrawable,
  });
  customer.withdrawable = fields.withdrawable;
  customer.nonWithdrawable = fields.nonWithdrawable;
  customer.affiliateBalance = fields.affiliateBalance;
  customer.cashbackBalance = fields.cashbackBalance;
  customer.walletAmount = fields.walletAmount;
  customer.closingBalance = fields.walletAmount;
  await customer.save();
  if (wallet) {
    await Wallet.updateOne(
      {_id: wallet._id},
      {
        $set: {
          balanceSchema: 2,
          withdrawable: fields.withdrawable,
          nonWithdrawable: fields.nonWithdrawable,
          affiliateBalance: fields.affiliateBalance,
          cashbackBalance: fields.cashbackBalance,
          walletAmount: fields.total,
        },
      },
    );
  }
};

const mergeNested = (target, source) => {
  if (!source || typeof source !== 'object') return target;
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      mergeNested(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
};

const toPlain = (value) => {
  if (!value) return {};
  return typeof value.toObject === 'function' ? value.toObject() : {...value};
};

const applyNested = (settings, field, payload) => {
  if (!payload) return;
  settings[field] = mergeNested(toPlain(settings[field]), payload);
  settings.markModified(field);
};

const withdrawalStatusToPayout = {
  requested: 'Pending',
  under_review: 'In Process',
  approved: 'In Process',
  paid: 'Paid',
  rejected: 'Failed',
};

const payoutStatusToWithdrawal = {
  Pending: 'requested',
  'In Process': 'under_review',
  Paid: 'paid',
  Failed: 'rejected',
};

const mapWithdrawalToPayout = (withdrawal) => ({
  _id: withdrawal._id,
  source: 'withdrawal',
  affiliateId: withdrawal.customer,
  amount: withdrawal.amount,
  status: withdrawalStatusToPayout[withdrawal.status] || 'Pending',
  payoutMethod: withdrawal.method === 'upi' ? 'UPI' : 'Bank Transfer',
  payoutDetails: withdrawal.payoutDetails,
  failureReason: withdrawal.status === 'rejected' ? withdrawal.adminNote || 'Rejected' : null,
  requestedAt: withdrawal.createdAt,
  processedAt: withdrawal.paidAt || withdrawal.reviewedAt || null,
  transactionId: withdrawal.walletDebitRef || null,
});

const mapPayoutRequest = (payout) => ({
  ...payout.toObject(),
  source: 'payout',
});

const ensureSettings = async () => {
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

// --- SETTINGS ---

export const getAffiliateSettings = async (req, res) => {
  try {
    const settings = await ensureSettings();
    res.status(200).json(settings);
  } catch (error) {
    res.status(500).json({message: error.message});
  }
};

export const updateAffiliateSettings = async (req, res) => {
  try {
    const payload = req.body;
    const settings = await ensureSettings();

    if (payload.isEnabled !== undefined) settings.isEnabled = payload.isEnabled;
    if (payload.rules) {
      settings.rules = normalizeAffiliateRules(payload.rules);
      settings.markModified('rules');
    }
    if (payload.milestones) settings.milestones = payload.milestones;
    applyNested(settings, 'withdrawal', payload.withdrawal);
    applyNested(settings, 'payoutSettings', payload.payoutSettings);
    applyNested(settings, 'programControls', payload.programControls);
    applyNested(settings, 'milestoneSettings', payload.milestoneSettings);
    applyNested(settings, 'notifications', payload.notifications);
    applyNested(settings, 'registrationSettings', payload.registrationSettings);
    applyNested(settings, 'referralCheckoutDiscount', payload.referralCheckoutDiscount);
    if (payload.cookieDurationDays !== undefined) settings.cookieDurationDays = payload.cookieDurationDays;
    if (payload.maxCommissionPerOrder !== undefined) settings.maxCommissionPerOrder = payload.maxCommissionPerOrder;
    if (payload.autoApproveCommissions !== undefined) settings.autoApproveCommissions = payload.autoApproveCommissions;
    if (payload.affiliateDashboardAccess !== undefined) settings.affiliateDashboardAccess = payload.affiliateDashboardAccess;
    if (payload.analyticsTracking !== undefined) settings.analyticsTracking = payload.analyticsTracking;

    settings.updatedBy = {
      m_staff_id: req.user?._id,
      m_staff_name: req.user?.name,
      m_staff_email: req.user?.email,
    };

    await settings.save();
    res.status(200).json(settings);
  } catch (error) {
    res.status(500).json({message: error.message});
  }
};

// --- OVERVIEW & STATS ---

export const getAffiliateOverview = async (req, res) => {
  try {
    const affiliates = await Customer.find({membershipType: {$ne: 'none'}}).select(
      'name email affiliateBalance totalCustomersReferred createdAt membershipType status',
    );

    const revenueAgg = await CommissionLedger.aggregate([
      {$group: {_id: null, total: {$sum: '$orderAmount'}, commissions: {$sum: '$commissionAmount'}}},
    ]);

    const referralCount = await Customer.countDocuments({referredBy: {$ne: null}});

    const topAffiliates = await Customer.aggregate([
      {$match: {membershipType: {$ne: 'none'}}},
      {
        $lookup: {
          from: 'commissionledgers',
          localField: '_id',
          foreignField: 'affiliateId',
          as: 'commissions',
        },
      },
      {
        $addFields: {
          totalCommissionEarned: {$sum: '$commissions.commissionAmount'},
          totalRevenueGenerated: {$sum: '$commissions.orderAmount'},
        },
      },
      {$sort: {totalCommissionEarned: -1}},
      {$limit: 5},
      {
        $project: {
          name: 1,
          email: 1,
          customerId: 1,
          totalCommissionEarned: 1,
          totalRevenueGenerated: 1,
          affiliateBalance: 1,
        },
      },
    ]);

    res.status(200).json({
      totalAffiliates: affiliates.length,
      totalRevenue: revenueAgg[0]?.total || 0,
      totalCommissions: revenueAgg[0]?.commissions || 0,
      totalReferrals: referralCount,
      topAffiliates,
    });
  } catch (error) {
    res.status(500).json({message: error.message});
  }
};

export const getAffiliateLeaderboard = async (req, res) => {
  try {
    const customers = await Customer.aggregate([
      {$match: {membershipType: {$ne: 'none'}}},
      {
        $lookup: {
          from: 'commissionledgers',
          localField: '_id',
          foreignField: 'affiliateId',
          as: 'commissions',
        },
      },
      {
        $addFields: {
          totalCommissionEarned: {$sum: '$commissions.commissionAmount'},
          totalRevenueGenerated: {$sum: '$commissions.orderAmount'},
        },
      },
      {$sort: {totalCommissionEarned: -1}},
      {$limit: 50},
      {
        $project: {
          name: 1,
          mobile: 1,
          email: 1,
          referralCode: 1,
          affiliateBalance: 1,
          totalCommissionEarned: 1,
          totalRevenueGenerated: 1,
        },
      },
    ]);

    res.status(200).json(customers);
  } catch (error) {
    res.status(500).json({message: error.message});
  }
};

export const getAffiliateStats = async (req, res) => {
  try {
    const totalAffiliates = await Customer.countDocuments({membershipType: {$ne: 'none'}});

    const commissions = await AffiliateCommission.aggregate([
      {
        $group: {
          _id: '$status',
          totalAmount: {$sum: '$commissionAmount'},
        },
      },
    ]);

    res.status(200).json({totalAffiliates, commissions});
  } catch (error) {
    res.status(500).json({message: error.message});
  }
};

export const getWalletSummary = async (req, res) => {
  try {
    const balanceAgg = await Customer.aggregate([
      {$match: {membershipType: {$ne: 'none'}}},
      {
        $group: {
          _id: null,
          totalWalletBalance: {
            $sum: {$add: ['$affiliateBalance', '$affiliateReserved']},
          },
          withdrawableBalance: {$sum: '$affiliateBalance'},
        },
      },
    ]);

    const payoutStats = await PayoutRequest.aggregate([
      {
        $group: {
          _id: '$status',
          total: {$sum: '$amount'},
          count: {$sum: 1},
        },
      },
    ]);

    const withdrawalStats = await WalletWithdrawal.aggregate([
      {
        $group: {
          _id: '$status',
          total: {$sum: '$amount'},
          count: {$sum: 1},
        },
      },
    ]);

    const findStat = (items, status) => items.find(s => s._id === status) || {total: 0, count: 0};

    const pendingTotal =
      findStat(payoutStats, 'Pending').total +
      findStat(withdrawalStats, 'requested').total;
    const inProcessTotal =
      findStat(payoutStats, 'In Process').total +
      findStat(withdrawalStats, 'under_review').total +
      findStat(withdrawalStats, 'approved').total;
    const paidTotal =
      findStat(payoutStats, 'Paid').total + findStat(withdrawalStats, 'paid').total;

    res.status(200).json({
      totalWalletBalance: balanceAgg[0]?.totalWalletBalance || 0,
      withdrawableBalance: balanceAgg[0]?.withdrawableBalance || 0,
      pendingPayouts: pendingTotal,
      inProcessPayouts: inProcessTotal,
      totalPayoutsAllTime: paidTotal,
    });
  } catch (error) {
    res.status(500).json({message: error.message});
  }
};

// --- AFFILIATES LIST ---

/**
 * Anyone with an assigned referralCode is an affiliate.
 * Revenue / commission come from AffiliateCommission (inviter).
 * Referred customers = unique users with referredBy = affiliate
 *   plus unique buyers attributed on commission rows.
 * Joined By = the customer in referredBy (who referred this affiliate).
 */
const buildAffiliatePipeline = (match = {}) => [
  {$match: match},
  {
    $lookup: {
      from: 'affiliatecommissions',
      let: {affiliateId: '$_id'},
      pipeline: [
        {
          $match: {
            $expr: {$eq: ['$inviter', '$$affiliateId']},
            status: {$nin: ['cancelled', 'reversed']},
          },
        },
        {
          $project: {
            orderAmount: 1,
            commissionAmount: 1,
            referredCustomer: 1,
            category: 1,
            status: 1,
          },
        },
      ],
      as: 'commissions',
    },
  },
  {
    $lookup: {
      from: 'customers',
      let: {affiliateId: '$_id'},
      pipeline: [
        {
          $match: {
            $expr: {$eq: ['$referredBy', '$$affiliateId']},
            isDeleted: {$ne: true},
          },
        },
        {$project: {_id: 1, name: 1}},
      ],
      as: 'referredCustomers',
    },
  },
  {
    $lookup: {
      from: 'customers',
      localField: 'referredBy',
      foreignField: '_id',
      as: 'joinedByCustomer',
    },
  },
  {
    $addFields: {
      totalRevenueGenerated: {$sum: '$commissions.orderAmount'},
      totalCommissionEarned: {$sum: '$commissions.commissionAmount'},
      joinedByDoc: {$arrayElemAt: ['$joinedByCustomer', 0]},
      referredCustomerIds: {
        $setUnion: [
          {
            $map: {
              input: '$referredCustomers',
              as: 'rc',
              in: '$$rc._id',
            },
          },
          {
            $filter: {
              input: {
                $map: {
                  input: '$commissions',
                  as: 'c',
                  in: '$$c.referredCustomer',
                },
              },
              as: 'id',
              cond: {$ne: ['$$id', null]},
            },
          },
        ],
      },
    },
  },
  {
    $addFields: {
      totalCustomersReferred: {$size: {$ifNull: ['$referredCustomerIds', []]}},
      joinedByName: {$ifNull: ['$joinedByDoc.name', null]},
      joinedByReferralCode: {$ifNull: ['$joinedByDoc.referralCode', null]},
      joinedById: {$ifNull: ['$joinedByDoc._id', null]},
      joinedByLabel: {
        $cond: [
          {$ifNull: ['$joinedByDoc.name', false]},
          '$joinedByDoc.name',
          'Direct',
        ],
      },
    },
  },
  {
    $project: {
      name: 1,
      email: 1,
      mobile: 1,
      customerId: 1,
      membershipType: 1,
      membershipPlanId: 1,
      status: 1,
      createdAt: 1,
      referralCode: 1,
      referredBy: 1,
      affiliateBalance: 1,
      walletAmount: 1,
      totalCustomersReferred: 1,
      totalRevenueGenerated: 1,
      totalCommissionEarned: 1,
      joinedByName: 1,
      joinedByReferralCode: 1,
      joinedById: 1,
      joinedByLabel: 1,
    },
  },
];

export const getAffiliatesList = async (req, res) => {
  try {
    const {
      status,
      membershipType,
      search,
      dateFrom,
      dateTo,
      sortBy = 'latest',
    } = req.query;

    // Affiliates = users who have been assigned a referral / affiliate code
    const match = {
      isDeleted: {$ne: true},
      referralCode: {$exists: true, $nin: [null, '']},
    };

    if (status && status !== 'all') match.status = status;
    if (membershipType && membershipType !== 'all') {
      match.membershipType = membershipType;
    }

    if (dateFrom || dateTo) {
      match.createdAt = {};
      if (dateFrom) match.createdAt.$gte = new Date(dateFrom);
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        match.createdAt.$lte = end;
      }
    }

    if (search) {
      const regex = new RegExp(String(search).trim(), 'i');
      match.$or = [
        {name: regex},
        {email: regex},
        {customerId: regex},
        {mobile: regex},
        {referralCode: regex},
      ];
    }

    const pipeline = buildAffiliatePipeline(match);

    const sortMap = {
      latest: {createdAt: -1},
      oldest: {createdAt: 1},
      revenue: {totalRevenueGenerated: -1},
      commission: {totalCommissionEarned: -1},
      referrals: {totalCustomersReferred: -1},
    };
    pipeline.push({$sort: sortMap[sortBy] || sortMap.latest});

    const affiliates = await Customer.aggregate(pipeline);
    res.status(200).json(affiliates);
  } catch (error) {
    res.status(500).json({message: error.message});
  }
};

export const getAffiliateById = async (req, res) => {
  try {
    const {id} = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({message: 'Invalid affiliate id'});
    }

    const pipeline = buildAffiliatePipeline({
      _id: new mongoose.Types.ObjectId(id),
      isDeleted: {$ne: true},
      referralCode: {$exists: true, $nin: [null, '']},
    });
    const results = await Customer.aggregate(pipeline);

    if (!results.length) {
      return res.status(404).json({message: 'Affiliate not found'});
    }

    const affiliate = results[0];

    const breakdown = await AffiliateCommission.aggregate([
      {
        $match: {
          inviter: affiliate._id,
          status: {$nin: ['cancelled', 'reversed']},
        },
      },
      {
        $group: {
          _id: '$category',
          count: {$sum: 1},
          revenue: {$sum: '$orderAmount'},
          commission: {$sum: '$commissionAmount'},
        },
      },
      {$sort: {revenue: -1}},
    ]);

    const referredCustomers = await Customer.find({
      referredBy: affiliate._id,
      isDeleted: {$ne: true},
    })
      .select('name email mobile referralCode membershipType createdAt')
      .sort({createdAt: -1})
      .limit(50)
      .lean();

    res.status(200).json({
      ...affiliate,
      activeCustomers: affiliate.totalCustomersReferred || 0,
      revenueBreakdown: breakdown.map(row => ({
        ...row,
        _id: row._id || 'other',
        label:
          {
            invite: 'Signup Bonus',
            product: 'Store Supplies',
            space: 'Space Booking',
            service: 'Services',
            food: 'Food Orders',
            membership: 'Membership',
            other: 'Other',
          }[row._id] || row._id,
      })),
      referredCustomers,
    });
  } catch (error) {
    res.status(500).json({message: error.message});
  }
};

// --- PAYOUTS ---

export const getPayoutsList = async (req, res) => {
  try {
    const {status, payoutMethod, search, dateFrom, dateTo} = req.query;

    const payoutFilter = {};
    const withdrawalFilter = {};

    if (dateFrom || dateTo) {
      const dateRange = {};
      if (dateFrom) dateRange.$gte = new Date(dateFrom);
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        dateRange.$lte = end;
      }
      payoutFilter.requestedAt = dateRange;
      withdrawalFilter.createdAt = dateRange;
    }

    const [payoutRequests, walletWithdrawals] = await Promise.all([
      PayoutRequest.find(payoutFilter)
        .populate('affiliateId', 'name email customerId')
        .sort({createdAt: -1}),
      WalletWithdrawal.find(withdrawalFilter)
        .populate('customer', 'name email customerId')
        .sort({createdAt: -1}),
    ]);

    let payouts = [
      ...payoutRequests.map(mapPayoutRequest),
      ...walletWithdrawals.map(mapWithdrawalToPayout),
    ].sort((a, b) => new Date(b.requestedAt || b.createdAt) - new Date(a.requestedAt || a.createdAt));

    if (status && status !== 'all') {
      payouts = payouts.filter((p) => p.status === status);
    }

    if (payoutMethod && payoutMethod !== 'all') {
      payouts = payouts.filter((p) => p.payoutMethod === payoutMethod);
    }

    if (search) {
      const q = search.toLowerCase();
      payouts = payouts.filter(
        (p) =>
          p.affiliateId?.name?.toLowerCase().includes(q) ||
          p.affiliateId?.customerId?.toLowerCase().includes(q) ||
          p.transactionId?.toLowerCase().includes(q),
      );
    }

    const stats = {pending: {total: 0, count: 0}, inProcess: {total: 0, count: 0}, paid: {total: 0, count: 0}, failed: {total: 0, count: 0}};
    const methodTotals = {};

    payouts.forEach((p) => {
      const key =
        p.status === 'Pending'
          ? 'pending'
          : p.status === 'In Process'
            ? 'inProcess'
            : p.status === 'Paid'
              ? 'paid'
              : p.status === 'Failed'
                ? 'failed'
                : null;
      if (key) {
        stats[key].total += p.amount || 0;
        stats[key].count += 1;
      }
      if (p.status === 'Paid') {
        const method = p.payoutMethod || 'Other';
        methodTotals[method] = (methodTotals[method] || 0) + (p.amount || 0);
      }
    });

    const methodStats = Object.entries(methodTotals).map(([_id, total]) => ({_id, total}));
    const failedRecent = payouts
      .filter((p) => p.status === 'Failed')
      .slice(0, 5);

    res.status(200).json({
      payouts,
      stats,
      methodStats,
      failedRecent,
    });
  } catch (error) {
    res.status(500).json({message: error.message});
  }
};

export const createManualPayout = async (req, res) => {
  try {
    const {affiliateId, amount, payoutMethod, payoutDetails, markPending} = req.body;

    if (!affiliateId || !amount || amount <= 0) {
      return res.status(400).json({message: 'Valid affiliateId and amount are required'});
    }

    const customer = await Customer.findById(affiliateId);
    if (!customer) {
      return res.status(404).json({message: 'Affiliate not found'});
    }

    if ((customer.affiliateBalance || 0) < amount) {
      return res.status(400).json({message: 'Insufficient affiliate balance for this payout'});
    }

    if (!markPending) {
      customer.affiliateBalance -= amount;
      await persistWithdrawableFromAffiliate(customer);
    } else {
      customer.affiliateReserved = (customer.affiliateReserved || 0) + amount;
      customer.affiliateBalance -= amount;
      await persistWithdrawableFromAffiliate(customer);
    }

    const payout = new PayoutRequest({
      affiliateId,
      amount,
      payoutMethod: payoutMethod || 'Manual',
      payoutDetails: payoutDetails || {},
      status: markPending ? 'Pending' : 'Paid',
      processedAt: markPending ? null : new Date(),
      processedBy: markPending
        ? undefined
        : {
            m_staff_id: req.user?._id,
            m_staff_name: req.user?.name,
          },
    });

    await payout.save();
    await payout.populate('affiliateId', 'name email customerId');

    res.status(201).json({
      message: markPending ? 'Payout request created' : 'Manual payout created and balance deducted',
      payout: mapPayoutRequest(payout),
    });
  } catch (error) {
    res.status(500).json({message: error.message});
  }
};

export const updatePayoutStatus = async (req, res) => {
  try {
    const {id} = req.params;
    const {status, failureReason, transactionId, source = 'payout'} = req.body;

    if (source === 'withdrawal') {
      const withdrawal = await WalletWithdrawal.findById(id).populate('customer', 'name email customerId');
      if (!withdrawal) {
        return res.status(404).json({message: 'Withdrawal request not found'});
      }

      const previousStatus = withdrawal.status;
      const nextWithdrawalStatus = payoutStatusToWithdrawal[status];
      if (!nextWithdrawalStatus) {
        return res.status(400).json({message: 'Invalid status'});
      }

      withdrawal.status = nextWithdrawalStatus;
      withdrawal.reviewedBy = {
        m_staff_id: req.user?._id,
        m_staff_name: req.user?.name,
        m_staff_email: req.user?.email,
      };
      withdrawal.reviewedAt = new Date();

      const customer = await Customer.findById(withdrawal.customer);

      if (status === 'Failed' && previousStatus !== 'rejected' && customer) {
        withdrawal.adminNote = failureReason || 'Rejected by admin';
        withdrawal.rejectedAt = new Date();
        if (withdrawal.reserved) {
          customer.affiliateBalance += withdrawal.amount;
          customer.affiliateReserved = Math.max(0, (customer.affiliateReserved || 0) - withdrawal.amount);
          await persistWithdrawableFromAffiliate(customer);
        }
      } else if (status === 'Paid' && previousStatus !== 'paid') {
        withdrawal.paidAt = new Date();
        withdrawal.walletDebitRef = transactionId || withdrawal.walletDebitRef;
        if (customer && withdrawal.reserved) {
          customer.affiliateReserved = Math.max(0, (customer.affiliateReserved || 0) - withdrawal.amount);
          await customer.save();
        }
      }

      await withdrawal.save();
      return res.status(200).json({
        message: 'Withdrawal status updated',
        payout: mapWithdrawalToPayout(withdrawal),
      });
    }

    const payout = await PayoutRequest.findById(id);
    if (!payout) {
      return res.status(404).json({message: 'Payout request not found'});
    }

    const previousStatus = payout.status;
    payout.status = status;

    if (status === 'Failed' && previousStatus !== 'Failed') {
      payout.failureReason = failureReason || 'Payment failed';
      const customer = await Customer.findById(payout.affiliateId);
      if (customer) {
        customer.affiliateBalance += payout.amount;
        customer.affiliateReserved = Math.max(0, (customer.affiliateReserved || 0) - payout.amount);
        await persistWithdrawableFromAffiliate(customer);
      }
    } else if (status === 'Paid' && previousStatus !== 'Paid') {
      payout.transactionId = transactionId;
      payout.processedAt = new Date();
      payout.processedBy = {
        m_staff_id: req.user?._id,
        m_staff_name: req.user?.name,
      };

      if (previousStatus === 'Pending' || previousStatus === 'In Process') {
        const customer = await Customer.findById(payout.affiliateId);
        if (customer) {
          customer.affiliateReserved = Math.max(0, (customer.affiliateReserved || 0) - payout.amount);
          await customer.save();
        }
      }
    } else if (status === 'In Process' && previousStatus === 'Pending') {
      const customer = await Customer.findById(payout.affiliateId);
      if (customer && (customer.affiliateReserved || 0) < payout.amount) {
        customer.affiliateReserved = (customer.affiliateReserved || 0) + payout.amount;
        await customer.save();
      }
    }

    await payout.save();
    await payout.populate('affiliateId', 'name email customerId');

    res.status(200).json({message: 'Payout status updated', payout: mapPayoutRequest(payout)});
  } catch (error) {
    res.status(500).json({message: error.message});
  }
};

const calculateReferralCheckoutDiscount = (config, orderAmount) => {
  const amount = Number(orderAmount || 0);
  if (!Number.isFinite(amount) || amount <= 0) return 0;

  const minOrder = Number(config?.minOrderAmount || 0);
  if (amount < minOrder) return 0;

  let raw = 0;
  if (config?.discountType === 'fixed') {
    raw = Number(config.discountValue || 0);
  } else {
    raw = (amount * Number(config.discountValue || 0)) / 100;
  }

  const maxCap = Number(config?.maxDiscountAmount);
  if (Number.isFinite(maxCap) && maxCap > 0) {
    raw = Math.min(raw, maxCap);
  }

  return Math.max(0, Math.min(amount, Math.round(raw * 100) / 100));
};

const RULE_SEGMENT_LABELS = {
  product: 'Store Supplies',
  membership: 'Membership',
  space: 'Space Booking',
  service: 'Services',
  food: 'Food Orders',
  other: 'Other',
};

const mapLineCategoryToRuleCategory = raw => {
  const value = String(raw || '')
    .trim()
    .toLowerCase();
  if (!value || value === 'general') return 'product';
  if (['product', 'membership', 'space', 'service', 'food', 'other'].includes(value)) {
    return value;
  }
  if (value.includes('store') || value.includes('supply') || value.includes('product')) {
    return 'product';
  }
  if (value.includes('membership')) return 'membership';
  if (value.includes('space') || value.includes('booking')) return 'space';
  if (value.includes('service')) return 'service';
  if (value.includes('food')) return 'food';
  return 'product';
};

const calculateCommissionRuleDiscount = (rule, orderAmount) => {
  const amount = Number(orderAmount || 0);
  if (!rule || rule.enabled === false || amount <= 0) return 0;
  if (amount < Number(rule.minOrderAmount || 0)) return 0;

  const raw =
    rule.commissionType === 'percentage'
      ? (amount * Number(rule.commissionValue || 0)) / 100
      : Number(rule.commissionValue || 0);
  const max = Number(rule.maxCommissionAmount);
  const capped = Number.isFinite(max) && max > 0 ? Math.min(raw, max) : raw;
  return Math.max(0, Math.min(amount, Math.round(capped * 100) / 100));
};

const calculateReferralDiscountFromRules = (rules = [], items = [], fallbackAmount = 0) => {
  const ruleMap = new Map(
    (Array.isArray(rules) ? rules : [])
      .filter(rule => rule?.category && rule.category !== 'invite')
      .map(rule => [rule.category, rule]),
  );

  const normalizedItems = Array.isArray(items)
    ? items
        .map(item => {
          const qty = Number(item.qty ?? item.quantity ?? 1) || 1;
          const unitPrice = Number(item.unitPrice ?? item.price ?? 0) || 0;
          const lineDiscount = Number(item.discount ?? 0) || 0;
          const lineAmount = Math.max(
            0,
            Number(item.lineTotal ?? qty * unitPrice - lineDiscount) || 0,
          );
          const ruleCategory = mapLineCategoryToRuleCategory(
            item.category || item.productName || item.name,
          );
          return {
            ruleCategory,
            lineAmount,
            name: String(item.name ?? item.productName ?? '').trim(),
          };
        })
        .filter(item => item.lineAmount > 0)
    : [];

  const segments = [];

  if (normalizedItems.length > 0) {
    for (const item of normalizedItems) {
      const rule = ruleMap.get(item.ruleCategory);
      const discountAmount = calculateCommissionRuleDiscount(rule, item.lineAmount);
      if (discountAmount <= 0) continue;

      const existing = segments.find(segment => segment.category === item.ruleCategory);
      if (existing) {
        existing.lineAmount += item.lineAmount;
        existing.discountAmount += discountAmount;
        if (item.name) existing.items.push(item.name);
      } else {
        segments.push({
          category: item.ruleCategory,
          label: rule?.label || RULE_SEGMENT_LABELS[item.ruleCategory] || item.ruleCategory,
          commissionType: rule?.commissionType || 'percentage',
          commissionValue: Number(rule?.commissionValue || 0),
          lineAmount: item.lineAmount,
          discountAmount,
          items: item.name ? [item.name] : [],
        });
      }
    }
  } else if (fallbackAmount > 0) {
    const rule = ruleMap.get('product') || ruleMap.get('other');
    const discountAmount = calculateCommissionRuleDiscount(rule, fallbackAmount);
    if (discountAmount > 0) {
      segments.push({
        category: rule?.category || 'product',
        label: rule?.label || RULE_SEGMENT_LABELS.product,
        commissionType: rule?.commissionType || 'percentage',
        commissionValue: Number(rule?.commissionValue || 0),
        lineAmount: fallbackAmount,
        discountAmount,
        items: [],
      });
    }
  }

  segments.forEach(segment => {
    segment.lineAmount = Math.round(segment.lineAmount * 100) / 100;
    segment.discountAmount = Math.round(segment.discountAmount * 100) / 100;
  });

  const discountAmount = segments.reduce(
    (sum, segment) => sum + Number(segment.discountAmount || 0),
    0,
  );

  return {
    discountAmount: Math.round(discountAmount * 100) / 100,
    segments,
  };
};

export const validateReferralDiscountForOrder = async ({
  customerId,
  customerPhone,
  referralCode,
  orderAmount,
  items,
}) => {
  const settings = await ensureSettings();

  if (settings.isEnabled === false) {
    return {
      ok: false,
      message: 'Affiliate program is disabled.',
    };
  }

  const amount = Number(orderAmount || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return {ok: false, message: 'Order amount must be greater than 0.'};
  }

  let buyer = null;
  if (customerId && mongoose.Types.ObjectId.isValid(String(customerId))) {
    buyer = await Customer.findById(customerId);
  } else if (customerPhone) {
    const phone = String(customerPhone).trim();
    buyer = await Customer.findOne({
      $or: [{mobile: phone}, {whatsappNumber: phone}],
      isDeleted: {$ne: true},
    });
  }

  let inviter = null;
  const manualCode = String(referralCode || '')
    .trim()
    .toUpperCase();

  if (manualCode) {
    inviter = await Customer.findOne({
      referralCode: manualCode,
      isDeleted: {$ne: true},
    });
    if (!inviter) {
      return {ok: false, message: 'Referral code not found.'};
    }
  } else if (buyer?.referredBy) {
    inviter = await Customer.findById(buyer.referredBy);
    if (!inviter) {
      return {ok: false, message: 'Referrer not found for this customer.'};
    }
  } else {
    return {
      ok: false,
      message: 'Customer was not referred and no referral code was provided.',
    };
  }

  if (
    buyer &&
    String(buyer._id) === String(inviter._id) &&
    settings.programControls?.allowSelfReferral !== true
  ) {
    return {ok: false, message: 'Self referral discount is not allowed.'};
  }

  if (!buyer) {
    return {
      ok: false,
      message: 'Select a customer account to apply a referral code.',
    };
  }

  const {discountAmount: computedAmount, segments} =
    calculateReferralDiscountFromRules(settings.rules, items, amount);

  if (computedAmount <= 0 || segments.length === 0) {
    return {
      ok: false,
      message:
        'No enabled commission rules apply for these cart items. Turn on Space Booking / Services / Food Orders (or matching) rules on the Affiliate page.',
    };
  }

  // Prefer explicit flag; also treat any prior paid referral discount on this account as used
  // (covers invoices created before referralDiscountUsed was introduced).
  let discountAlreadyUsed = buyer.referralDiscountUsed === true;
  if (!discountAlreadyUsed) {
    const phone = String(buyer.mobile || customerPhone || '').trim();
    const buyerId = buyer._id;
    const invoiceIdentity = [
      ...(buyerId
        ? [{customerId: buyerId}, {'referral.buyerId': buyerId}]
        : []),
      ...(phone ? [{customerPhone: phone}] : []),
    ];

    const priorInvoice =
      invoiceIdentity.length > 0
        ? await Invoice.findOne({
            status: {$ne: 'cancelled'},
            'referral.discountAmount': {$gt: 0},
            $or: invoiceIdentity,
          })
            .select('_id invoiceCode')
            .lean()
        : null;

    const priorSubscription =
      !priorInvoice && phone
        ? await Subscription.findOne({
            status: {$nin: ['cancelled']},
            'referral.discountAmount': {$gt: 0},
            customerPhone: phone,
          })
            .select('_id subscriptionCode')
            .lean()
        : null;

    if (priorInvoice || priorSubscription) {
      discountAlreadyUsed = true;
      // Backfill so later checks are fast
      await Customer.updateOne(
        {_id: buyer._id, referralDiscountUsed: {$ne: true}},
        {
          $set: {
            referralDiscountUsed: true,
            referralDiscountUsedAt: new Date(),
            referralDiscountSourceId: String(
              priorInvoice?.invoiceCode ||
                priorSubscription?.subscriptionCode ||
                '',
            ),
          },
        },
      );
    }
  }

  const discountEligible = !discountAlreadyUsed;
  const discountAmount = discountEligible ? computedAmount : 0;
  const primary = segments[0];
  // Keep segment commission amounts even when buyer discount is 0
  const commissionSegments = segments.map(segment => ({
    ...segment,
    commissionAmount: Number(segment.discountAmount || 0),
    buyerDiscountAmount: discountEligible ? Number(segment.discountAmount || 0) : 0,
  }));

  const ruleLabel =
    segments.length === 1
      ? String(primary.label || 'Referral').trim()
      : 'Referral';

  return {
    ok: true,
    discountEligible,
    discountAlreadyUsed,
    discountAmount,
    commissionAmount: computedAmount,
    segments: commissionSegments,
    referralCode: inviter.referralCode,
    inviterName: inviter.name || '',
    inviterId: inviter._id,
    discountType: primary.commissionType || 'percentage',
    discountValue: Number(primary.commissionValue || 0),
    label: discountEligible
      ? `${ruleLabel} Referral Discount`
      : `${ruleLabel} (commission only)`,
    buyerId: buyer._id,
    message: discountAlreadyUsed
      ? 'Referral discount already used on this account. Referrer will still earn commission.'
      : 'Referral discount applied',
  };
};

export const validateReferralDiscount = async (req, res) => {
  try {
    const result = await validateReferralDiscountForOrder(req.body || {});
    if (!result.ok) {
      return res.status(400).json({success: false, message: result.message});
    }
    return res.status(200).json({
      success: true,
      message: result.message || 'Referral discount applied',
      data: result,
    });
  } catch (error) {
    res.status(500).json({success: false, message: error.message});
  }
};

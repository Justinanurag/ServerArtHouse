import Customer from '../../../models/customer.model.js';
import Wallet from '../../../models/wallet.model.js';
import WalletWithdrawal from '../../../models/walletWithdrawal.model.js';
import AffiliateCommission from '../../../models/affiliateCommission.model.js';
import CommissionLedger from '../../../models/commissionLedger.model.js';
import {getReferralDashboard} from './referral.service.js';
import {resolveTwoBuckets} from '../../../utils/walletBuckets.js';

const startOfMonth = () => {
  const date = new Date();
  return new Date(date.getFullYear(), date.getMonth(), 1);
};

const categoryLabels = {
  invite: 'Signup',
  membership: 'Membership',
  product: 'Shopping',
  space: 'Booking',
  service: 'Services',
  food: 'Food',
  affiliate: 'Withdrawable',
  csp: 'CSP Sale',
  other: 'Other',
};

const statusIsEarned = status =>
  ['approved', 'credited', 'Approved', 'Paid'].includes(status);

const normalizeCategory = record => {
  if (record.category) return record.category;
  const legacy = String(record.orderType || 'other').toLowerCase();
  if (legacy === 'store') return 'product';
  if (legacy === 'services') return 'service';
  if (legacy === 'milestone') return 'other';
  return legacy;
};

export const getWalletDashboard = async (customerId, appBaseUrl) => {
  const customer = await Customer.findById(customerId).lean();
  if (!customer || customer.isDeleted) {
    const error = new Error('Customer not found');
    error.status = 404;
    throw error;
  }

  const monthStart = startOfMonth();
  const [
    wallet,
    commissions,
    legacyCommissions,
    withdrawals,
    referral,
    referralsThisMonth,
  ] = await Promise.all([
    Wallet.findOne({customerId}).lean(),
    AffiliateCommission.find({inviter: customerId})
      .sort({createdAt: -1})
      .lean(),
    CommissionLedger.find({affiliateId: customerId})
      .sort({createdAt: -1})
      .lean(),
    WalletWithdrawal.find({customer: customerId})
      .sort({createdAt: -1})
      .lean(),
    getReferralDashboard(customerId, appBaseUrl),
    Customer.countDocuments({
      referredBy: customerId,
      isDeleted: {$ne: true},
      createdAt: {$gte: monthStart},
    }),
  ]);

  const usePrimaryCommissions = commissions.length > 0;
  const earningRecords = usePrimaryCommissions ? commissions : legacyCommissions;

  let liveWallet = wallet;
  let buckets = resolveTwoBuckets(wallet, customer);

  // Restore signup welcome ₹ wiped by older membership-cashback wallet create
  if (customer.welcomeBonusCredited && buckets.nonWithdrawable <= 0) {
    const welcomeAmount = (() => {
      const n = Number(
        process.env.WHATSAPP_ACCOUNT_CREATED_CASHBACK ||
          process.env.ACCOUNT_WELCOME_CASHBACK ||
          21,
      );
      return Number.isFinite(n) && n > 0 ? n : 21;
    })();
    const txs = Array.isArray(wallet?.transactions) ? wallet.transactions : [];
    const hasWelcomeCredit = txs.some(
      tx =>
        String(tx.type || '').toLowerCase() === 'credit' &&
        (String(tx.referenceType || '') === 'WelcomeBonus' ||
          /welcome|signup/i.test(String(tx.note || ''))),
    );
    const hasSpendDebit = txs.some(
      tx => String(tx.type || '').toLowerCase() === 'debit',
    );
    if (!hasWelcomeCredit && !hasSpendDebit && welcomeAmount > 0) {
      try {
        const {appendTransaction} = await import(
          '../../../controllers/wallet.controller.js'
        );
        let mutableWallet = await Wallet.findOne({customerId});
        if (!mutableWallet) {
          mutableWallet = await Wallet.create({
            customerId,
            customerName: String(customer.name ?? '').trim(),
            customerPhone: String(customer.mobile ?? '').trim(),
            withdrawable: buckets.withdrawable,
            nonWithdrawable: 0,
            affiliateBalance: buckets.withdrawable,
            cashbackBalance: 0,
            walletAmount: buckets.withdrawable,
            transactions: [],
          });
        }
        liveWallet = await appendTransaction(mutableWallet, {
          type: 'credit',
          amount: welcomeAmount,
          note: 'Signup welcome bonus (restored)',
          referenceType: 'WelcomeBonus',
          referenceId: `welcome:${customerId}`,
          walletType: 'nonWithdrawable',
          createdBy: {
            m_staff_id: null,
            m_staff_name: 'System',
            m_staff_email: null,
          },
        });
        buckets = resolveTwoBuckets(liveWallet, customer);
      } catch (error) {
        console.error(
          '[WalletDashboard] welcome bonus restore failed:',
          error?.message || error,
        );
      }
    }
  }

  const withdrawable = buckets.withdrawable;
  const nonWithdrawable = buckets.nonWithdrawable;
  const totalAvailable = buckets.total;

  const affiliateReserved = Number(customer.affiliateReserved || 0);

  const earnedRecords = earningRecords.filter(record =>
    statusIsEarned(record.status),
  );
  const earnedThisMonth = earnedRecords
    .filter(record => new Date(record.createdAt) >= monthStart)
    .reduce(
      (sum, record) =>
        sum + Number(record.commissionAmount || 0),
      0,
    );
  const revenueThisMonth = earningRecords
    .filter(record => new Date(record.createdAt) >= monthStart)
    .reduce((sum, record) => sum + Number(record.orderAmount || 0), 0);
  const transactionsThisMonth = earningRecords.filter(
    record => new Date(record.createdAt) >= monthStart,
  ).length;

  const categories = Object.entries(categoryLabels).map(([category, label]) => {
    const categoryRecords = earningRecords.filter(record => {
      return normalizeCategory(record) === category;
    });
    return {
      category,
      label,
      amount: categoryRecords
        .filter(record => statusIsEarned(record.status))
        .reduce((sum, record) => sum + Number(record.commissionAmount || 0), 0),
      transactionCount: categoryRecords.length,
    };
  });

  const walletTransactions = (liveWallet?.transactions || wallet?.transactions || []).map(transaction => {
    const refType = String(transaction.referenceType || '').trim();
    const isCsp = refType === 'CspSale';
    const walletType = String(
      transaction.walletType || 'nonWithdrawable',
    ).toLowerCase();
    const isWithdrawableCredit =
      isCsp ||
      walletType === 'affiliate' ||
      walletType === 'withdrawable';
    return {
      id: String(transaction._id),
      kind: 'wallet',
      title:
        transaction.note ||
        (isCsp
          ? 'CSP sale share'
          : transaction.type === 'credit'
            ? 'Wallet credit'
            : 'Wallet debit'),
      type: transaction.type,
      amount: Number(transaction.amount || 0),
      status: 'completed',
      category: isCsp
        ? 'csp'
        : isWithdrawableCredit
          ? 'affiliate'
          : walletType === 'cashback' || walletType === 'nonwithdrawable'
            ? 'cashback'
            : walletType || 'cashback',
      withdrawable: isWithdrawableCredit,
      withdrawableDeducted: Number(transaction.withdrawableDeducted || 0),
      nonWithdrawableDeducted: Number(
        transaction.nonWithdrawableDeducted || 0,
      ),
      createdAt: transaction.createdAt,
    };
  });

  const commissionTransactions = earningRecords.map(record => ({
    id: String(record._id),
    kind: 'commission',
    title:
      record.description ||
      `${categoryLabels[record.category] || record.orderType || 'Affiliate'} earning`,
    type:
      ['cancelled', 'reversed', 'Cancelled'].includes(record.status)
        ? 'debit'
        : 'credit',
    amount: Number(record.commissionAmount || 0),
    status: record.status,
    category:
      normalizeCategory(record),
    createdAt: record.createdAt,
  }));

  const withdrawalTransactions = withdrawals.map(withdrawal => ({
    id: String(withdrawal._id),
    kind: 'withdrawal',
    title:
      withdrawal.method === 'bank'
        ? 'Withdrawal to bank'
        : 'Withdrawal to UPI',
    type: 'debit',
    amount: Number(withdrawal.amount || 0),
    status: withdrawal.status,
    category: 'withdrawal',
    createdAt: withdrawal.createdAt,
  }));

  const transactions = [
    ...walletTransactions,
    ...commissionTransactions,
    ...withdrawalTransactions,
  ]
    .filter(transaction => transaction.createdAt)
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

  const conversionRate =
    referral.stats.totalReferrals > 0
      ? Math.round(
          (referral.stats.activeReferrals / referral.stats.totalReferrals) *
            1000,
        ) / 10
      : 0;

  return {
    balances: {
      totalAvailable,
      withdrawable,
      nonWithdrawable,
      affiliateBalance: withdrawable,
      affiliateReserved,
      cashbackBalance: nonWithdrawable,
      generalBalance: 0,
    },
    summary: {
      cashbackBalance: nonWithdrawable,
      totalAffiliateEarned: referral.stats.totalEarned,
      rewardTransactions: earningRecords.length,
      totalTransactions: transactions.length,
    },
    affiliateThisMonth: {
      earnings: earnedThisMonth,
      referrals: referralsThisMonth,
      revenue: revenueThisMonth,
      conversionRate,
      transactionCount: transactionsThisMonth,
    },
    categories,
    transactions,
    referral: {
      referralCode: referral.referralCode,
      shareUrl: referral.shareUrl,
      shareMessage: referral.shareMessage,
    },
    updatedAt: new Date().toISOString(),
  };
};

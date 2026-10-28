import Customer from '../models/customer.model.js';
import Wallet from '../models/wallet.model.js';
import {debitWalletForPurchase} from '../controllers/wallet.controller.js';
import {resolveTwoBuckets} from '../utils/walletBuckets.js';

const roundMoney = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
};

export const remainingCashbackToReverse = (invoice) => {
  const total = Math.max(0, Number(invoice?.cashbackTotal ?? 0));
  const already = Math.max(0, Number(invoice?.cashbackReversedTotal ?? 0));
  return Math.max(0, roundMoney(total - already));
};

/**
 * Reverse previously credited membership cashback from the customer wallet.
 * Idempotent per referenceId. Caps to available balance (min balance ignored).
 */
export const reverseMembershipCashback = async ({
  customer,
  amount,
  invoiceCode,
  referenceId,
  note,
  createdBy,
}) => {
  const requested = roundMoney(Math.max(0, Number(amount ?? 0)));
  if (!customer?._id || !(requested > 0)) {
    return {reversed: 0, skipped: true};
  }

  const wallet = await Wallet.findOne({customerId: customer._id});
  if (!wallet) {
    return {reversed: 0, skipped: true};
  }

  const code = String(invoiceCode || '').trim();
  const ref = String(referenceId || `${code}:cashback-reverse`).trim();

  const already = (wallet.transactions || []).some(
    (tx) =>
      String(tx.referenceId || '').trim() === ref &&
      String(tx.type || '').toLowerCase() === 'debit',
  );
  if (already) {
    return {reversed: 0, skipped: true};
  }

  const customerLean = await Customer.findById(customer._id)
    .select(
      'walletAmount closingBalance affiliateBalance cashbackBalance withdrawable nonWithdrawable',
    )
    .lean();
  const buckets = resolveTwoBuckets(wallet, customerLean);
  const toDebit = Math.min(requested, Math.max(0, buckets.total));
  if (!(toDebit > 0)) {
    return {reversed: 0, skipped: true};
  }

  const reason =
    String(note || '').trim() || `Cashback reversed for invoice ${code}`;

  await debitWalletForPurchase(wallet, {
    amount: toDebit,
    note: reason,
    referenceType: 'cashback_reverse',
    referenceId: ref,
    createdBy,
    minimumBalance: 0,
  });

  return {reversed: toDebit, skipped: false};
};

/**
 * Canonical customer wallet: exactly two types.
 *   withdrawable     — affiliate / referral / CSP eligible earnings
 *   nonWithdrawable  — cashback, welcome bonus, staff credits, other restricted amounts
 *
 * Total = withdrawable + nonWithdrawable (always derived, never stored independently).
 */

export const roundMoney = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
};

/**
 * Merge customer denormalized bucket with wallet ledger bucket.
 * 0 is a real value and must not hide the other side.
 */
export const pickBucketBalance = (customerVal, walletVal) => {
  const c = Number(customerVal);
  const w = Number(walletVal);
  const cOk = Number.isFinite(c);
  const wOk = Number.isFinite(w);
  if (cOk && wOk) {
    if (c === 0 && w !== 0) return roundMoney(w);
    if (w === 0 && c !== 0) return roundMoney(c);
    return roundMoney(w);
  }
  if (wOk) return roundMoney(w);
  if (cOk) return roundMoney(c);
  return 0;
};

const WITHDRAWABLE_TYPES = new Set([
  'withdrawable',
  'affiliate',
  'referral',
]);

const WITHDRAWABLE_REFS = new Set([
  'cspsale',
  'affiliate',
  'referral',
  'commission',
  'affiliatecommission',
  'referralcommission',
]);

/**
 * Classify a credit into one of the two wallet types.
 * Old walletType values (affiliate / cashback / general) map here.
 */
export const classifyWalletKind = ({
  walletType,
  referenceType,
  note,
} = {}) => {
  const type = String(walletType || '')
    .trim()
    .toLowerCase();
  if (type === 'nonwithdrawable' || type === 'non-withdrawable' || type === 'cashback' || type === 'general') {
    return 'nonWithdrawable';
  }
  if (WITHDRAWABLE_TYPES.has(type)) return 'withdrawable';

  const ref = String(referenceType || '')
    .trim()
    .toLowerCase();
  if (WITHDRAWABLE_REFS.has(ref)) return 'withdrawable';

  const text = String(note || '').toLowerCase();
  if (
    /\b(csp|affiliate|referral commission|commission earning)\b/.test(text) &&
    !/cashback/.test(text)
  ) {
    return 'withdrawable';
  }

  return 'nonWithdrawable';
};

const hasCanonicalTwoBucket = (doc) => {
  if (!doc || typeof doc !== 'object') return false;
  if (Number(doc.balanceSchema) === 2) return true;
  return doc.withdrawable != null || doc.nonWithdrawable != null;
};

/**
 * Resolve the two live balances from wallet ledger + customer denormalized fields.
 * Legacy docs (general + cashback + affiliate) collapse to two buckets:
 *   withdrawable    = affiliate
 *   nonWithdrawable = general + cashback
 */
export const resolveTwoBuckets = (wallet, customer) => {
  const affiliate = pickBucketBalance(
    customer?.affiliateBalance ?? customer?.withdrawable,
    wallet?.affiliateBalance ?? wallet?.withdrawable,
  );

  if (hasCanonicalTwoBucket(wallet) || hasCanonicalTwoBucket(customer)) {
    const withdrawable = pickBucketBalance(
      customer?.withdrawable ?? customer?.affiliateBalance,
      wallet?.withdrawable ?? wallet?.affiliateBalance,
    );
    const nonWithdrawable = pickBucketBalance(
      customer?.nonWithdrawable ?? customer?.cashbackBalance,
      wallet?.nonWithdrawable ?? wallet?.cashbackBalance,
    );
    return {
      withdrawable: Math.max(0, roundMoney(withdrawable)),
      nonWithdrawable: Math.max(0, roundMoney(nonWithdrawable)),
      total: Math.max(
        0,
        roundMoney(Math.max(0, withdrawable) + Math.max(0, nonWithdrawable)),
      ),
    };
  }

  const general = pickBucketBalance(
    customer?.walletAmount ?? customer?.closingBalance,
    wallet?.walletAmount,
  );
  const cashback = pickBucketBalance(
    customer?.cashbackBalance,
    wallet?.cashbackBalance,
  );
  const withdrawable = Math.max(0, roundMoney(affiliate));
  const nonWithdrawable = Math.max(0, roundMoney(general + cashback));
  return {
    withdrawable,
    nonWithdrawable,
    total: Math.max(0, roundMoney(withdrawable + nonWithdrawable)),
  };
};

/**
 * Debit split: Non-Withdrawable first, then Withdrawable.
 * Throws "Insufficient wallet balance" if amount > total.
 * Never returns negative buckets.
 */
export const computeDebitSplit = (amount, buckets, minimumBalance = 0) => {
  const requested = roundMoney(amount);
  if (!(requested > 0)) {
    throw new Error('Valid transaction amount is required.');
  }

  const withdrawable = Math.max(0, roundMoney(buckets?.withdrawable));
  const nonWithdrawable = Math.max(0, roundMoney(buckets?.nonWithdrawable));
  const totalBefore = roundMoney(withdrawable + nonWithdrawable);

  if (requested > totalBefore + 0.01) {
    throw new Error('Insufficient wallet balance');
  }

  const minBal = Math.max(0, roundMoney(minimumBalance));
  const maxPayable = Math.max(0, roundMoney(totalBefore - minBal));
  if (requested > maxPayable + 0.01) {
    throw new Error(
      `Wallet payment would leave balance below the minimum of ₹${minBal.toFixed(2)}. ` +
        `Available for payment: ₹${maxPayable.toFixed(2)} ` +
        `(balance ₹${totalBefore.toFixed(2)} − minimum ₹${minBal.toFixed(2)}).`,
    );
  }

  let remaining = requested;
  const fromNonWithdrawable = Math.min(nonWithdrawable, remaining);
  remaining = roundMoney(remaining - fromNonWithdrawable);
  const fromWithdrawable = Math.min(withdrawable, remaining);
  remaining = roundMoney(remaining - fromWithdrawable);

  if (remaining > 0.01) {
    throw new Error('Insufficient wallet balance');
  }

  const nextNonWithdrawable = roundMoney(nonWithdrawable - fromNonWithdrawable);
  const nextWithdrawable = roundMoney(withdrawable - fromWithdrawable);
  if (nextNonWithdrawable < -0.001 || nextWithdrawable < -0.001) {
    throw new Error('Insufficient wallet balance');
  }

  const totalAfter = roundMoney(
    Math.max(0, nextWithdrawable) + Math.max(0, nextNonWithdrawable),
  );
  if (totalAfter + 0.01 < minBal) {
    throw new Error(
      `Final wallet balance cannot be less than minimum balance ₹${minBal.toFixed(2)}.`,
    );
  }

  return {
    withdrawableDeducted: roundMoney(fromWithdrawable),
    nonWithdrawableDeducted: roundMoney(fromNonWithdrawable),
    withdrawable: Math.max(0, nextWithdrawable),
    nonWithdrawable: Math.max(0, nextNonWithdrawable),
    totalBalanceBefore: totalBefore,
    totalBalanceAfter: totalAfter,
  };
};

export const persistableBucketFields = ({
  withdrawable,
  nonWithdrawable,
}) => {
  const W = Math.max(0, roundMoney(withdrawable));
  const NW = Math.max(0, roundMoney(nonWithdrawable));
  const total = roundMoney(W + NW);
  return {
    balanceSchema: 2,
    withdrawable: W,
    nonWithdrawable: NW,
    affiliateBalance: W,
    cashbackBalance: NW,
    walletAmount: total,
    total,
  };
};

import mongoose from "mongoose";
import Customer from "../models/customer.model.js";
import Wallet from "../models/wallet.model.js";
import WalletSettings from "../models/walletSettings.model.js";
import {
  classifyWalletKind,
  computeDebitSplit,
  persistableBucketFields,
  resolveTwoBuckets,
  roundMoney,
} from "../utils/walletBuckets.js";

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildCreatedBy = (req, fallback = {}) => ({
  m_staff_id: fallback?.m_staff_id ?? req.user?.userId ?? null,
  m_staff_name: fallback?.m_staff_name ?? req.user?.name ?? null,
  m_staff_email: fallback?.m_staff_email ?? req.user?.email ?? null,
});

/** Read global minimum wallet balance (always ≥ 0). */
const getMinimumWalletBalance = async () => {
  const doc = await WalletSettings.findOne({key: 'default'})
    .select('minimumBalance')
    .lean();
  const n = Number(doc?.minimumBalance ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** Persist global minimum wallet balance from Wallet Instructions. */
const setMinimumWalletBalance = async (minimumBalance, updatedBy = {}) => {
  const value = Math.max(0, Number(minimumBalance) || 0);
  const doc = await WalletSettings.findOneAndUpdate(
    {key: 'default'},
    {
      $set: {
        minimumBalance: value,
        updatedBy: {
          m_staff_id: updatedBy?.m_staff_id ?? null,
          m_staff_name: updatedBy?.m_staff_name ?? null,
          m_staff_email: updatedBy?.m_staff_email ?? null,
        },
      },
    },
    {upsert: true, new: true, setDefaultsOnInsert: true},
  );
  return Math.max(0, Number(doc?.minimumBalance ?? value) || 0);
};

/**
 * Max amount that may be taken from wallet while keeping minimumBalance.
 * Rule: Wallet Balance − Payment Amount ≥ Minimum Wallet Balance
 */
const getMaxWalletPaymentAmount = (spendableBalance, minimumBalance = 0) => {
  const available = Math.max(0, Number(spendableBalance) || 0);
  const minBal = Math.max(0, Number(minimumBalance) || 0);
  return Math.max(0, available - minBal);
};

const syncCustomerWalletAmount = async (customerId, walletAmount) => {
  if (!mongoose.Types.ObjectId.isValid(String(customerId))) return;
  const total = Math.max(0, roundMoney(walletAmount));
  await Customer.findByIdAndUpdate(customerId, {
    $set: {
      walletAmount: total,
      closingBalance: total,
    },
  });
};

const syncCustomerWalletBuckets = async (
  customerId,
  { withdrawable, nonWithdrawable, walletAmount, affiliateBalance, cashbackBalance },
) => {
  if (!mongoose.Types.ObjectId.isValid(String(customerId))) return;
  const fields = persistableBucketFields({
    withdrawable:
      withdrawable ?? affiliateBalance,
    nonWithdrawable:
      nonWithdrawable ?? cashbackBalance,
  });
  const total =
    walletAmount !== undefined
      ? Math.max(0, roundMoney(walletAmount))
      : fields.total;
  await Customer.findByIdAndUpdate(customerId, {
    $set: {
      walletAmount: total,
      closingBalance: total,
      affiliateBalance: fields.affiliateBalance,
      cashbackBalance: fields.cashbackBalance,
      withdrawable: fields.withdrawable,
      nonWithdrawable: fields.nonWithdrawable,
    },
  });
};

const applyPersistedBuckets = (wallet, { withdrawable, nonWithdrawable }) => {
  const fields = persistableBucketFields({ withdrawable, nonWithdrawable });
  wallet.balanceSchema = 2;
  wallet.withdrawable = fields.withdrawable;
  wallet.nonWithdrawable = fields.nonWithdrawable;
  wallet.affiliateBalance = fields.affiliateBalance;
  wallet.cashbackBalance = fields.cashbackBalance;
  wallet.walletAmount = fields.total;
  return fields;
};

/** Persist ledger first, then denormalized customer aliases, so balances stay aligned. */
const persistWalletAndCustomer = async (wallet, fields) => {
  await wallet.save();
  await syncCustomerWalletBuckets(wallet.customerId, fields);
  return wallet;
};

const resolveCustomer = async ({ customerId, customerPhone }) => {
  if (customerId && mongoose.Types.ObjectId.isValid(String(customerId))) {
    return Customer.findById(customerId);
  }
  if (customerPhone) {
    return Customer.findOne({ mobile: String(customerPhone).trim() });
  }
  return null;
};

/** Total spendable = withdrawable + nonWithdrawable */
const getSpendableWalletBalance = (wallet, customer) => {
  return resolveTwoBuckets(wallet, customer).total;
};

const appendTransaction = async (
  wallet,
  {
    type,
    amount,
    note = "",
    referenceType = "",
    referenceId = "",
    createdBy = {},
    minimumBalance,
    walletType = "nonWithdrawable",
  },
) => {
  const numericAmount = roundMoney(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error("Valid transaction amount is required.");
  }
  const txType = String(type ?? "credit").toLowerCase();
  const refId = String(referenceId ?? "").trim();
  const reason = String(note ?? "").trim();

  if (txType === "debit") {
    return debitWalletForPurchase(wallet, {
      amount: numericAmount,
      note: reason,
      referenceType,
      referenceId: refId,
      createdBy,
      minimumBalance,
    });
  }

  if (refId && /cashback/i.test(reason)) {
    const duplicate = (wallet.transactions || []).some(
      (tx) =>
        String(tx.referenceId || "").trim() === refId &&
        String(tx.type || "").toLowerCase() === "credit" &&
        Math.abs(Number(tx.amount) - numericAmount) < 0.001 &&
        /cashback/i.test(String(tx.note || "")),
    );
    if (duplicate) return wallet;
  }
  if (refId && String(referenceType || "").trim() === "CspSale") {
    const duplicateCsp = (wallet.transactions || []).some(
      (tx) =>
        String(tx.referenceId || "").trim() === refId &&
        String(tx.type || "").toLowerCase() === "credit" &&
        String(tx.referenceType || "").trim() === "CspSale",
    );
    if (duplicateCsp) return wallet;
  }

  const customer = await Customer.findById(wallet.customerId)
    .select(
      "walletAmount closingBalance affiliateBalance cashbackBalance withdrawable nonWithdrawable",
    )
    .lean();
  const buckets = resolveTwoBuckets(wallet, customer);
  const kind = classifyWalletKind({ walletType, referenceType, note: reason });
  const totalBefore = buckets.total;
  let withdrawable = buckets.withdrawable;
  let nonWithdrawable = buckets.nonWithdrawable;

  if (kind === "withdrawable") {
    withdrawable = roundMoney(withdrawable + numericAmount);
  } else {
    nonWithdrawable = roundMoney(nonWithdrawable + numericAmount);
  }

  const fields = applyPersistedBuckets(wallet, {
    withdrawable,
    nonWithdrawable,
  });

  wallet.transactions.push({
    customerId: wallet.customerId,
    type: "credit",
    amount: numericAmount,
    walletType: kind,
    note: reason,
    reason,
    referenceType: String(referenceType ?? "").trim(),
    referenceId: refId,
    createdBy,
    previousBalance: totalBefore,
    closingBalance: fields.total,
    totalBalanceBefore: totalBefore,
    totalBalanceAfter: fields.total,
    withdrawableDeducted: 0,
    nonWithdrawableDeducted: 0,
    withdrawableAfter: fields.withdrawable,
    nonWithdrawableAfter: fields.nonWithdrawable,
    affiliateBalanceAfter: fields.withdrawable,
    cashbackBalanceAfter: fields.nonWithdrawable,
  });

  return persistWalletAndCustomer(wallet, fields);
};

/**
 * Debit from combined wallet: Non-Withdrawable first, then Withdrawable.
 * Records one history line with both deducted amounts.
 */
const debitWalletForPurchase = async (
  wallet,
  {
    amount,
    note = "",
    referenceType = "invoice",
    referenceId = "",
    createdBy = {},
    minimumBalance,
  } = {},
) => {
  const totalAmount = roundMoney(amount);
  if (!(totalAmount > 0) || !wallet) return wallet;

  const customer = await Customer.findById(wallet.customerId)
    .select(
      "walletAmount closingBalance affiliateBalance cashbackBalance withdrawable nonWithdrawable",
    )
    .lean();
  const buckets = resolveTwoBuckets(wallet, customer);
  const minBal =
    minimumBalance !== undefined && minimumBalance !== null
      ? Math.max(0, roundMoney(minimumBalance))
      : await getMinimumWalletBalance();

  const refId = String(referenceId ?? "").trim();
  if (refId) {
    const alreadyDebited = (wallet.transactions || []).some(
      (tx) =>
        String(tx.referenceId || "").trim() === refId &&
        String(tx.type || "").toLowerCase() === "debit" &&
        String(tx.referenceType || "").toLowerCase() ===
          String(referenceType || "invoice").toLowerCase(),
    );
    if (alreadyDebited) return wallet;
  }

  const split = computeDebitSplit(totalAmount, buckets, minBal);
  const fields = applyPersistedBuckets(wallet, {
    withdrawable: split.withdrawable,
    nonWithdrawable: split.nonWithdrawable,
  });

  const parts = [];
  if (split.nonWithdrawableDeducted > 0) {
    parts.push(`non-withdrawable ₹${split.nonWithdrawableDeducted}`);
  }
  if (split.withdrawableDeducted > 0) {
    parts.push(`withdrawable ₹${split.withdrawableDeducted}`);
  }
  const baseNote =
    String(note || "").trim() ||
    `Wallet used for ${referenceType || "purchase"} ${refId}`.trim();
  const detailNote =
    parts.length > 1 ? `${baseNote} (${parts.join(" + ")})` : baseNote;

  const kind =
    split.nonWithdrawableDeducted >= split.withdrawableDeducted
      ? "nonWithdrawable"
      : "withdrawable";

  wallet.transactions.push({
    customerId: wallet.customerId,
    type: "debit",
    amount: totalAmount,
    walletType: kind,
    note: detailNote,
    reason: detailNote,
    referenceType: String(referenceType ?? "").trim(),
    referenceId: refId,
    createdBy,
    previousBalance: split.totalBalanceBefore,
    closingBalance: split.totalBalanceAfter,
    totalBalanceBefore: split.totalBalanceBefore,
    totalBalanceAfter: split.totalBalanceAfter,
    withdrawableDeducted: split.withdrawableDeducted,
    nonWithdrawableDeducted: split.nonWithdrawableDeducted,
    withdrawableAfter: fields.withdrawable,
    nonWithdrawableAfter: fields.nonWithdrawable,
    affiliateBalanceAfter: fields.withdrawable,
    cashbackBalanceAfter: fields.nonWithdrawable,
  });

  return persistWalletAndCustomer(wallet, fields);
};

const getWallets = async (req, res) => {
  try {
    const search = String(req.query.search ?? "").trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 1000, 1), 5000);
    const query = { isDeleted: { $ne: true } };

    if (search) {
      const regex = new RegExp(escapeRegex(search), "i");
      query.$or = [
        { name: regex },
        { mobile: regex },
      ];
    }

    // When searching, don't limit — the user needs to find a specific customer
    const effectiveLimit = search ? 5000 : limit;
    const customers = await Customer.find(query).sort({ updatedAt: -1 }).limit(effectiveLimit).lean();
    
    const customerIds = customers.map(c => c._id);
    const wallets = await Wallet.find({ customerId: { $in: customerIds } }).lean();
    
    const walletMap = wallets.reduce((acc, w) => {
      acc[w.customerId.toString()] = w;
      return acc;
    }, {});

    const combinedWallets = customers.map(c => {
      const w = walletMap[c._id.toString()];
      const buckets = resolveTwoBuckets(w, c);
      return {
        _id: w ? w._id : null,
        customerId: c._id,
        customerName: c.name,
        customerPhone: c.mobile,
        walletAmount: buckets.total,
        totalBalance: buckets.total,
        withdrawable: buckets.withdrawable,
        nonWithdrawable: buckets.nonWithdrawable,
        withdrawableBalance: buckets.withdrawable,
        affiliateBalance: buckets.withdrawable,
        cashbackBalance: buckets.nonWithdrawable,
        transactions: w ? w.transactions : [],
        createdAt: w ? w.createdAt : c.createdAt,
        updatedAt: w ? w.updatedAt : c.updatedAt,
        hasWalletRecord: !!w,
      };
    });

    return res.status(200).json({
      success: true,
      message: "Wallets fetched successfully.",
      wallets: combinedWallets,
    });
  } catch (error) {
    console.error("getWallets error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch wallets.",
    });
  }
};

const createWallet = async (req, res) => {
  try {
    const {
      customerId,
      customerPhone,
      customerName,
      type = "credit",
      amount,
      note,
      referenceType,
      referenceId,
      createdBy,
    } = req.body;

    const customer = await resolveCustomer({ customerId, customerPhone });
    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Customer not found.",
      });
    }

    const seed = resolveTwoBuckets(null, customer);
    let wallet = await Wallet.findOne({ customerId: customer._id });
    if (!wallet) {
      wallet = await Wallet.create({
        customerId: customer._id,
        customerName: String(customer.name ?? customerName ?? "").trim(),
        customerPhone: String(customer.mobile ?? customerPhone ?? "").trim(),
        ...persistableBucketFields(seed),
        transactions: [],
      });
    }

    const updatedWallet = await appendTransaction(wallet, {
      type: String(type ?? "credit").toLowerCase(),
      amount,
      note,
      referenceType,
      referenceId,
      minimumBalance: req.body?.minimumBalance,
      walletType:
        req.body?.walletType || "nonWithdrawable",
      createdBy: buildCreatedBy(req, createdBy),
    });

    return res.status(201).json({
      success: true,
      message: "Wallet updated successfully.",
      wallet: updatedWallet,
    });
  } catch (error) {
    console.error("createWallet error:", error);
    return res.status(400).json({
      success: false,
      message: error.message || "Failed to update wallet.",
    });
  }
};

const getWalletById = async (req, res) => {
  try {
    const { id } = req.params;
    let wallet = null;

    if (mongoose.Types.ObjectId.isValid(id)) {
      wallet = await Wallet.findById(id).lean();
      if (!wallet) {
        wallet = await Wallet.findOne({ customerId: id }).lean();
      }
    }

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: "Wallet not found.",
      });
    }

    const customer = await Customer.findById(wallet.customerId)
      .select('walletAmount closingBalance affiliateBalance cashbackBalance withdrawable nonWithdrawable name mobile welcomeBonusCredited')
      .lean();

    let buckets = resolveTwoBuckets(wallet, customer);

    // One-time heal: membership cashback used to wipe signup ₹ when wallet was created at 0.
    if (customer?.welcomeBonusCredited && buckets.nonWithdrawable <= 0) {
      const welcomeAmount = (() => {
        const n = Number(
          process.env.WHATSAPP_ACCOUNT_CREATED_CASHBACK ||
            process.env.ACCOUNT_WELCOME_CASHBACK ||
            21,
        );
        return Number.isFinite(n) && n > 0 ? n : 21;
      })();
      const txs = Array.isArray(wallet.transactions) ? wallet.transactions : [];
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
          const liveWallet = await Wallet.findById(wallet._id);
          if (liveWallet) {
            await appendTransaction(liveWallet, {
              type: 'credit',
              amount: welcomeAmount,
              note: 'Signup welcome bonus (restored)',
              referenceType: 'WelcomeBonus',
              referenceId: `welcome:${customer._id}`,
              walletType: 'nonWithdrawable',
              createdBy: {
                m_staff_id: null,
                m_staff_name: 'System',
                m_staff_email: null,
              },
            });
            buckets = resolveTwoBuckets(liveWallet, customer);
            wallet.transactions = liveWallet.transactions;
          }
        } catch (healError) {
          console.error(
            '[Wallet] welcome bonus restore failed:',
            healError?.message || healError,
          );
        }
      }
    }

    const persisted = persistableBucketFields(buckets);
    if (wallet._id) {
      await Wallet.updateOne(
        {_id: wallet._id},
        {
          $set: {
            balanceSchema: 2,
            withdrawable: persisted.withdrawable,
            nonWithdrawable: persisted.nonWithdrawable,
            affiliateBalance: persisted.affiliateBalance,
            cashbackBalance: persisted.cashbackBalance,
            walletAmount: persisted.total,
          },
        },
      );
    }
    if (wallet.customerId) {
      await syncCustomerWalletBuckets(wallet.customerId, persisted);
    }

    return res.status(200).json({
      success: true,
      message: "Wallet fetched successfully.",
      wallet: {
        ...wallet,
        walletAmount: buckets.total,
        totalBalance: buckets.total,
        withdrawable: buckets.withdrawable,
        nonWithdrawable: buckets.nonWithdrawable,
        withdrawableBalance: buckets.withdrawable,
        affiliateBalance: buckets.withdrawable,
        cashbackBalance: buckets.nonWithdrawable,
      },
    });
  } catch (error) {
    console.error("getWalletById error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch wallet.",
    });
  }
};

const updateWallet = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      type,
      amount,
      note,
      referenceType,
      referenceId,
      createdBy,
      customerName,
      customerPhone,
    } = req.body;
    // console.log(req.body);

    let wallet = null;
    if (mongoose.Types.ObjectId.isValid(id)) {
      wallet = await Wallet.findById(id);
      if (!wallet) {
        wallet = await Wallet.findOne({ customerId: id });
      }
    }

    // Auto-create wallet if the id is actually a customerId with no wallet yet
    if (!wallet && mongoose.Types.ObjectId.isValid(id)) {
      const customer = await Customer.findById(id).lean();
      if (customer) {
        const seed = resolveTwoBuckets(null, customer);
        wallet = await Wallet.create({
          customerId: customer._id,
          customerName: String(customer.name ?? customerName ?? "").trim(),
          customerPhone: String(customer.mobile ?? customerPhone ?? "").trim(),
          ...persistableBucketFields(seed),
          transactions: [],
        });
      }
    }

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: "Wallet not found.",
      });
    }

    if (customerName !== undefined) wallet.customerName = String(customerName).trim();
    if (customerPhone !== undefined) wallet.customerPhone = String(customerPhone).trim();

    const hasTransaction = amount !== undefined || type !== undefined;
    if (hasTransaction) {
      wallet = await appendTransaction(wallet, {
        type: String(type ?? "credit").toLowerCase(),
        amount,
        note,
        referenceType,
        referenceId,
        minimumBalance: req.body?.minimumBalance,
        walletType:
          req.body?.walletType || "nonWithdrawable",
        createdBy: buildCreatedBy(req, createdBy),
      });
    } else {
      await wallet.save();
    }

    return res.status(200).json({
      success: true,
      message: "Wallet updated successfully.",
      wallet,
    });
  } catch (error) {
    console.error("updateWallet error:", error);
    return res.status(400).json({
      success: false,
      message: error.message || "Failed to update wallet.",
    });
  }
};

const deleteWallet = async (req, res) => {
  try {
    const { id } = req.params;
    let wallet = null;

    if (mongoose.Types.ObjectId.isValid(id)) {
      wallet = await Wallet.findById(id);
      if (!wallet) {
        wallet = await Wallet.findOne({ customerId: id });
      }
    }

    if (!wallet) {
      return res.status(404).json({
        success: false,
        message: "Wallet not found.",
      });
    }

    await Wallet.deleteOne({ _id: wallet._id });
    await syncCustomerWalletBuckets(wallet.customerId, {
      withdrawable: 0,
      nonWithdrawable: 0,
      walletAmount: 0,
    });

    return res.status(200).json({
      success: true,
      message: "Wallet deleted successfully.",
    });
  } catch (error) {
    console.error("deleteWallet error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to delete wallet.",
    });
  }
};

const bulkUpdateWallets = async (req, res) => {
  try {
    const {
      type = "credit",
      amount,
      note,
      createdBy,
      minimumBalance,
    } = req.body ?? {};
    console.log("This is bulk update:",req.body);
    const normalizedType = String(type).toLowerCase();
    const numericAmount = Number(amount);
    const fromBodyMinimum = Math.max(Number(minimumBalance) || 0, 0);
    const persistedMinimum = await getMinimumWalletBalance();
    // Debits must always respect the saved global minimum; body may be stricter.
    const minimumAllowedBalance =
      normalizedType === "debit"
        ? Math.max(fromBodyMinimum, persistedMinimum)
        : fromBodyMinimum;

    if (!["credit", "debit", "set_minimum"].includes(normalizedType)) {
      return res.status(400).json({
        success: false,
        message: "Transaction type is invalid.",
      });
    }

    if (normalizedType === "set_minimum") {
      const savedMinimum = await setMinimumWalletBalance(
        fromBodyMinimum,
        buildCreatedBy(req, createdBy),
      );
      return res.status(200).json({
        success: true,
        message: "Minimum balance updated successfully.",
        minimumBalance: savedMinimum,
      });
    }

if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
  return res.status(400).json({
    success: false,
    message: "Valid transaction amount is required.",
  });
}

    const customers = await Customer.find({})
      .select("_id name mobile walletAmount closingBalance affiliateBalance cashbackBalance withdrawable nonWithdrawable")
      .lean();
    if (customers.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No customers available for bulk wallet update.",
        updatedCount: 0,
      });
    }

    const customerIds = customers.map((entry) => entry._id);
    const wallets = await Wallet.find({ customerId: { $in: customerIds } });
    const walletMap = new Map(wallets.map((entry) => [String(entry.customerId), entry]));

    const invalidCustomers = [];
    for (const customer of customers) {
      const key = String(customer._id);
      const wallet = walletMap.get(key);
      const spendable = resolveTwoBuckets(wallet, customer).total;

      if (normalizedType === "debit" && !wallet) {
        invalidCustomers.push({
          customerId: key,
          customerName: customer.name,
          customerPhone: customer.mobile,
          reason: "Wallet does not exist.",
        });
        continue;
      }

      const nextBalance =
        normalizedType === "debit"
          ? spendable - numericAmount
          : spendable + numericAmount;
      if (nextBalance < minimumAllowedBalance) {
        invalidCustomers.push({
          customerId: key,
          customerName: customer.name,
          customerPhone: customer.mobile,
          reason:
            nextBalance < 0
              ? "Insufficient wallet balance"
              : `Would fall below minimum balance ${minimumAllowedBalance}.`,
        });
      }
    }

    if (invalidCustomers.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Bulk update blocked by minimum balance or missing wallet records.",
        invalidCustomers,
      });
    }

    let updatedCount = 0;
    for (const customer of customers) {
      const key = String(customer._id);
      let wallet = walletMap.get(key);

      if (!wallet) {
        wallet = await Wallet.create({
          customerId: customer._id,
          customerName: String(customer.name ?? "").trim(),
          customerPhone: String(customer.mobile ?? "").trim(),
          ...persistableBucketFields(resolveTwoBuckets(null, customer)),
          transactions: [],
        });
      }

      await appendTransaction(wallet, {
        type: normalizedType,
        amount: numericAmount,
        note,
        minimumBalance: minimumAllowedBalance,
        createdBy: buildCreatedBy(req, createdBy),
      });
      updatedCount += 1;
    }

    return res.status(200).json({
      success: true,
      message: `Bulk wallet ${normalizedType} applied successfully.`,
      updatedCount,
    });
  } catch (error) {
    console.error("bulkUpdateWallets error:", error);
    return res.status(400).json({
      success: false,
      message: error.message || "Failed to apply bulk wallet update.",
    });
  }
};

const getWalletInstructions = async (req, res) => {
  try {
    const minimumBalance = await getMinimumWalletBalance();
    return res.status(200).json({
      success: true,
      message: 'Wallet instructions fetched successfully.',
      instructions: {
        minimumBalance,
      },
      minimumBalance,
    });
  } catch (error) {
    console.error('getWalletInstructions error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch wallet instructions.',
    });
  }
};

export {
  appendTransaction,
  bulkUpdateWallets,
  createWallet,
  debitWalletForPurchase,
  deleteWallet,
  getMaxWalletPaymentAmount,
  getMinimumWalletBalance,
  getSpendableWalletBalance,
  getWalletById,
  getWalletInstructions,
  getWallets,
  setMinimumWalletBalance,
  syncCustomerWalletAmount,
  updateWallet,
};

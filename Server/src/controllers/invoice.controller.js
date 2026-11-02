import mongoose from 'mongoose';
import Counter from '../models/counter.model.js';
import Customer from '../models/customer.model.js';
import Coupon from '../models/coupon.model.js';
import Invoice from '../models/invoice.model.js';
import Wallet from '../models/wallet.model.js';
import {
  enrichItemsWithCsp,
  settleCspPaymentSplit,
  reverseCspPaymentSplit,
} from '../services/cspPaymentSplit.service.js';
import { computeStockByProductNames } from '../utils/inventoryStock.utils.js';
import {
  appendTransaction,
  debitWalletForPurchase,
  getMaxWalletPaymentAmount,
  getMinimumWalletBalance,
  getSpendableWalletBalance,
} from './wallet.controller.js';
import { validateCouponForOrder } from './coupon.controller.js';
import { validateReferralDiscountForOrder } from './affiliate.controller.js';
import { creditReferralDiscountToInviter, markReferralDiscountUsed } from '../modules/customer/services/referral.service.js';
import { sendActivityUpdateWhatsApp } from '../modules/customer/services/whatsapp.service.js';
import { normalizeMobile } from '../modules/customer/utils/normalize.js';
import {isMembershipPurchaseLine, normalizeLineType} from '../utils/itemClassification.utils.js';
import {bookingPaymentError} from '../utils/bookingPayment.js';
import {getBookingPaymentRule} from '../services/bookingPaymentSettings.service.js';
import {
  remainingCashbackToReverse,
  reverseMembershipCashback,
} from '../services/membershipCashbackWallet.service.js';
import {
  isCustomerMembershipExpired,
  MEMBERSHIP_EXPIRED_MESSAGE,
} from '../services/membershipEligibility.service.js';

const roundMoney = value => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
};

/** Products track inventory; space / service / food / membership do not. */
const isInventoryTrackedCategory = raw => {
  const value = String(raw || '')
    .trim()
    .toLowerCase();
  if (!value || value === 'general' || value === 'product') return true;
  if (
    ['space', 'service', 'food', 'membership', 'other'].includes(value) ||
    value.includes('space') ||
    value.includes('booking') ||
    value.includes('service') ||
    value.includes('food') ||
    value.includes('membership')
  ) {
    return false;
  }
  return true;
};

const assertSufficientPurchaseStock = async ({
  items,
  excludeInvoiceId = null,
}) => {
  const requestNames = (items || [])
    .filter(item => isInventoryTrackedCategory(item.category))
    .map(item => String(item.productName ?? '').trim())
    .filter(Boolean);

  if (!requestNames.length) return null;

  const stockMap = await computeStockByProductNames({
    names: requestNames,
    excludeInvoiceId,
  });
  const requestedQtyMap = new Map();

  for (const item of items) {
    if (!isInventoryTrackedCategory(item.category)) continue;
    const name = String(item.productName ?? '').trim();
    const qty = Number(item.qty ?? 0);
    requestedQtyMap.set(name, (requestedQtyMap.get(name) ?? 0) + qty);
  }

  for (const [name, requestedQty] of requestedQtyMap.entries()) {
    const availableQty = Number(stockMap.get(name) ?? 0);
    if (requestedQty > availableQty) {
      return {
        success: false,
        message: `Insufficient stock for ${name}. Available from purchases: ${availableQty}, requested: ${requestedQty}.`,
      };
    }
  }

  return null;
};

const isSoftReferralSkipMessage = message =>
  /no referral discount applies|no enabled commission rules|no commission rules/i.test(
    String(message || ''),
  );

const getStartOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const getNextInvoiceNumber = async () => {
  const counter = await Counter.findOneAndUpdate(
    {key: 'invoice_number'},
    {$inc: {value: 1}},
    {new: true, upsert: true, setDefaultsOnInsert: true},
  );
  return counter.value;
};

const buildCreatedBy = (req, fallback = {}) => ({
  m_staff_id: fallback?.m_staff_id ?? req.user?.userId ?? null,
  m_staff_name: fallback?.m_staff_name ?? req.user?.name ?? null,
  m_staff_email: fallback?.m_staff_email ?? req.user?.email ?? null,
});

const findCustomerForInvoice = async ({
  customerId,
  customerPhone,
  customerName,
}) => {
  const id = String(customerId ?? '').trim();
  if (id && mongoose.Types.ObjectId.isValid(id)) {
    const byId = await Customer.findById(id);
    if (byId) return byId;
  }

  const phone = String(customerPhone ?? '').trim();
  const digits = normalizeMobile(phone) || phone.replace(/\D/g, '');
  if (digits) {
    const byPhone = await Customer.findOne({
      $or: [
        { mobile: phone },
        { mobile: digits },
        { mobile: `+91${digits}` },
        { mobile: `91${digits}` },
        { whatsappNumber: phone },
        { whatsappNumber: digits },
        { whatsappNumber: `+91${digits}` },
      ],
    });
    if (byPhone) return byPhone;
  }

  const name = String(customerName ?? '').trim();
  if (name) {
    return Customer.findOne({ name });
  }

  return null;
};

const resolveActivityType = ({ activityType, notes, items }) => {
  const explicit = String(activityType || '').trim();
  if (explicit) return explicit;

  const note = String(notes || '').toLowerCase();
  if (note.includes('food bill') || note.includes('foodbill')) return 'Food Bill';
  if (note.includes('space')) return 'Space Booking';
  if (note.includes('pos')) return 'POS Sale';

  const cats = (Array.isArray(items) ? items : []).map(i =>
    String(i?.category || '').toLowerCase(),
  );
  if (cats.length && cats.every(c => c.includes('food'))) return 'Food Bill';
  if (cats.length && cats.every(c => c.includes('space'))) return 'Space Booking';
  if (cats.length && cats.every(c => c.includes('service'))) return 'Service';
  if (cats.length && cats.every(c => c.includes('product') || !c || c === 'general')) {
    return 'Purchase';
  }
  return 'Invoice';
};

const membershipLabelForCustomer = (customer, fallbackType) => {
  const raw = String(
    customer?.membershipType || fallbackType || 'none',
  )
    .trim()
    .toLowerCase();
  if (!raw || raw === 'none' || raw === 'new' || raw === 'guest') return 'Guest';
  const title = raw.charAt(0).toUpperCase() + raw.slice(1);
  return `${title} Member`;
};

/** Prefer real money paid; never leave WhatsApp Amount Paid at 0 when grandTotal exists */
const resolveAmountPaid = (invoice, overridePaid) => {
  const override = Number(overridePaid);
  if (Number.isFinite(override) && override > 0) return override;

  const breakdown = invoice?.paymentBreakdown?.toObject
    ? invoice.paymentBreakdown.toObject()
    : invoice?.paymentBreakdown || {};

  const explicit = Number(breakdown.paidAmount);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  const parts =
    Number(breakdown.cash ?? 0) +
    Number(breakdown.upi ?? 0) +
    Number(breakdown.card ?? 0) +
    Number(breakdown.wallet ?? 0);
  if (parts > 0) return parts;

  const grand = Number(invoice?.grandTotal);
  if (Number.isFinite(grand) && grand > 0) return grand;

  return 0;
};

/**
 * Discount line = savings on the bill.
 * Never use (subTotal - 0) when paid failed to resolve — that shows full bill as "discount".
 */
const resolveActivityDiscount = ({
  subTotal,
  paid,
  membershipDiscount,
  discountTotal,
  couponDiscount,
  referralDiscount,
}) => {
  const sub = Number(subTotal) || 0;
  const paidAmt = Number(paid) || 0;
  const membershipDisc = Math.max(0, Number(membershipDiscount) || 0);
  const invoiceDisc = Math.max(0, Number(discountTotal) || 0);
  const coupon = Math.max(0, Number(couponDiscount) || 0);
  const referral = Math.max(0, Number(referralDiscount) || 0);

  // Real savings only when we know what was paid
  if (paidAmt > 0 && sub > paidAmt + 0.001) {
    return Math.round((sub - paidAmt) * 100) / 100;
  }

  if (membershipDisc > 0) return membershipDisc;

  const netInvoiceDisc = Math.max(0, invoiceDisc - coupon - referral);
  if (netInvoiceDisc > 0) return netInvoiceDisc;

  return 0;
};

const notifyActivityUpdateWhatsApp = async ({
  customer,
  customerName,
  customerPhone,
  invoice,
  notes,
  items,
  activityType,
  membershipDiscount,
  cashbackTotal,
  membershipType: membershipTypeHint,
  amountPaidOverride,
  subTotalOverride,
}) => {
  try {
    if (!invoice || invoice.status === 'draft' || invoice.status === 'cancelled') {
      return;
    }

    const phone =
      String(customer?.whatsappNumber || '').trim() ||
      String(customer?.mobile || customerPhone || '').trim();
    if (!phone) return;

    const paid = resolveAmountPaid(invoice, amountPaidOverride);
    const subTotal = Number(
      subTotalOverride ?? invoice?.subTotal ?? 0,
    );

    let discountAmt = resolveActivityDiscount({
      subTotal,
      paid,
      membershipDiscount,
      discountTotal: invoice?.discountTotal,
      couponDiscount: invoice?.coupon?.discountAmount,
      referralDiscount: invoice?.referral?.discountAmount,
    });

    // Hard guard: never show full bill as "discount" with Amount Paid ₹0
    let amountPaidFinal = paid;
    if (amountPaidFinal <= 0 && discountAmt > 0) {
      amountPaidFinal = discountAmt;
      discountAmt = 0;
    }
    if (
      amountPaidFinal <= 0 &&
      Number(amountPaidOverride) > 0
    ) {
      amountPaidFinal = Number(amountPaidOverride);
    }
    if (amountPaidFinal <= 0 && Number(invoice?.grandTotal) > 0) {
      amountPaidFinal = Number(invoice.grandTotal);
    }

    const cashbackAmt = Math.max(0, Number(cashbackTotal ?? 0));

    // Live TOTAL wallet after debit + cashback credit (withdrawable + nonWithdrawable).
    let walletBalance = getSpendableWalletBalance(null, customer);
    let membershipType = customer?.membershipType || membershipTypeHint;
    if (customer?._id) {
      const [fresh, walletDoc] = await Promise.all([
        Customer.findById(customer._id)
          .select(
            'walletAmount closingBalance cashbackBalance affiliateBalance withdrawable nonWithdrawable membershipType name',
          )
          .lean(),
        Wallet.findOne({customerId: customer._id})
          .select(
            'walletAmount cashbackBalance affiliateBalance withdrawable nonWithdrawable balanceSchema',
          )
          .lean(),
      ]);
      if (fresh) {
        if (fresh.membershipType) membershipType = fresh.membershipType;
      }
      walletBalance = getSpendableWalletBalance(walletDoc, fresh || customer);
    }
    walletBalance = Math.max(
      0,
      Math.round((Number(walletBalance) + Number.EPSILON) * 100) / 100,
    );

    // WhatsApp "Download Invoice" is a dynamic URL ending in /activities/{{1}}.
    // {{1}} is this bill's id. That page is public, so the customer opens it
    // without logging in.
    const detailsUrlParam = String(invoice?._id || '').trim();

    const membershipLabel = membershipLabelForCustomer(
      { membershipType },
      membershipTypeHint,
    );

    console.log('[ActivityUpdate] notify payload', {
      phone,
      amountPaidFinal,
      subTotal,
      discountAmt,
      cashbackAmt,
      walletBalance,
      membershipLabel,
      membershipType,
      grandTotal: invoice?.grandTotal,
      paidAmount: invoice?.paymentBreakdown?.paidAmount,
      amountPaidOverride,
    });

    await sendActivityUpdateWhatsApp({
      to: phone,
      name: customer?.name || customerName,
      activityType: resolveActivityType({ activityType, notes, items }),
      amountPaid: amountPaidFinal,
      membershipLabel,
      discountAmount: discountAmt,
      cashbackAmount: cashbackAmt,
      walletBalance,
      detailsUrlParam,
    });
  } catch (err) {
    console.error('[ActivityUpdate] notify error:', err?.message || err);
  }
};

const applyWalletDelta = async ({
  customer,
  invoiceCode,
  amount,
  createdBy,
  note,
}) => {
  const numericAmount = Number(amount ?? 0);
  if (!customer || !Number.isFinite(numericAmount) || numericAmount === 0) {
    return;
  }

  let wallet = await Wallet.findOne({ customerId: customer._id });
  if (!wallet) {
    wallet = await Wallet.create({
      customerId: customer._id,
      customerName: String(customer.name ?? '').trim(),
      customerPhone: String(customer.mobile ?? '').trim(),
      walletAmount: 0,
      cashbackBalance: 0,
      affiliateBalance: 0,
      transactions: [],
    });
  }

  // amount > 0 means customer is paying with wallet (debit across buckets)
  if (numericAmount > 0) {
    await debitWalletForPurchase(wallet, {
      amount: numericAmount,
      note,
      referenceType: 'invoice',
      referenceId: invoiceCode,
      createdBy,
    });
    return;
  }

  // Refund / credit back to general bucket
  await appendTransaction(wallet, {
    type: 'credit',
    amount: Math.abs(numericAmount),
    walletType: 'nonWithdrawable',
    note,
    referenceType: 'invoice',
    referenceId: invoiceCode,
    createdBy,
  });
};

/** Credit membership cashback to customer wallet (idempotent per invoice). */
const creditMembershipCashback = async ({
  customer,
  invoiceCode,
  amount,
  createdBy,
  activityType,
}) => {
  const cashbackAmt = Math.max(0, Number(amount ?? 0));
  if (!customer?._id || !(cashbackAmt > 0)) return null;

  let wallet = await Wallet.findOne({ customerId: customer._id });
  if (!wallet) {
    wallet = await Wallet.create({
      customerId: customer._id,
      customerName: String(customer.name ?? '').trim(),
      customerPhone: String(customer.mobile ?? '').trim(),
      walletAmount: 0,
      transactions: [],
    });
  }

  const ref = String(invoiceCode || '').trim();
  const alreadyCredited = (wallet.transactions || []).some(
    tx =>
      String(tx.referenceId || '').trim() === ref &&
      String(tx.type || '').toLowerCase() === 'credit' &&
      /cashback/i.test(String(tx.note || '')),
  );
  if (alreadyCredited) {
    return wallet;
  }

  return appendTransaction(wallet, {
    type: 'credit',
    amount: cashbackAmt,
    note: `Membership cashback for ${String(activityType || 'Invoice').trim() || 'Invoice'} ${ref}`,
    referenceType: 'invoice',
    referenceId: ref,
    walletType: 'nonWithdrawable',
    createdBy,
  });
};

/** Credit CSP 70% to owner wallet + store 30% platform share (only after full payment). */
const creditCspsailorShares = async ({items, invoiceCode, createdBy, invoice}) => {
  const inv =
    invoice ||
    (invoiceCode
      ? await Invoice.findOne({invoiceCode: String(invoiceCode).trim()})
      : null);
  if (!inv) return null;
  return settleCspPaymentSplit({
    invoice: inv,
    items: items || inv.items,
    createdBy,
  });
};

/** Reverse CSP credits for an invoice (cancel/delete). */
const reverseCspsailorShares = async ({invoice, createdBy}) =>
  reverseCspPaymentSplit({invoice, createdBy});

const membershipBenefitsRequested = ({items, membershipDiscount, cashbackTotal} = {}) => {
  if (Math.max(0, Number(membershipDiscount) || 0) > 0) return true;
  if (Math.max(0, Number(cashbackTotal) || 0) > 0) return true;
  return (Array.isArray(items) ? items : []).some(item => {
    if (isMembershipPurchaseLine(item?.category || item?.lineCategory || item?.sourceType)) {
      return false;
    }
    if (item?.isCsp) return false;
    return (
      Math.max(0, Number(item?.membershipDiscountAmount) || 0) > 0 ||
      Math.max(0, Number(item?.cashback) || 0) > 0
    );
  });
};

const membershipBenefitTotal = ({items, membershipDiscount, cashbackTotal} = {}) => {
  const header =
    Math.max(0, Number(membershipDiscount) || 0) +
    Math.max(0, Number(cashbackTotal) || 0);
  const lines = (Array.isArray(items) ? items : []).reduce((sum, item) => {
    if (isMembershipPurchaseLine(item?.category || item?.lineCategory || item?.sourceType)) {
      return sum;
    }
    if (item?.isCsp) return sum;
    return (
      sum +
      Math.max(0, Number(item?.membershipDiscountAmount) || 0) +
      Math.max(0, Number(item?.cashback) || 0)
    );
  }, 0);
  return header + lines;
};

const rejectExpiredMembershipBenefits = async (res, customer, benefitArgs, previousArgs) => {
  if (!membershipBenefitsRequested(benefitArgs)) return false;
  if (!(await isCustomerMembershipExpired(customer))) return false;
  // An invoice that already has these benefits can be saved again.
  // A larger discount or cashback after expiry is refused.
  if (
    previousArgs &&
    membershipBenefitTotal(benefitArgs) <= membershipBenefitTotal(previousArgs) + 0.009
  ) {
    return false;
  }
  res.status(400).json({
    success: false,
    code: 'MEMBERSHIP_EXPIRED',
    message: MEMBERSHIP_EXPIRED_MESSAGE,
  });
  return true;
};

const applyCouponUsageDelta = async ({ code, delta }) => {
  const normalizedCode = String(code ?? '').trim().toUpperCase();
  if (!normalizedCode || !Number.isFinite(Number(delta)) || Number(delta) === 0) return;
  await Coupon.updateOne(
    { code: normalizedCode },
    {
      $inc: { usedCount: Number(delta) },
    },
  );
};

/** Keep product vs membership split on the line. Membership is already inside `discount`. */
const normalizeInvoiceItem = (item, previous = {}) => {
  const qty = Number(item.qty);
  const unitPrice = Number(item.unitPrice);
  const discount = Math.max(0, Number(item.discount ?? 0) || 0);
  const lineTotal = qty * unitPrice - discount;
  const isCsp = Boolean(item.isCsp || previous.isCsp);
  const purchasingMembership = isMembershipPurchaseLine(
    item.category || item.lineCategory || item.sourceType,
  );
  const cashback = isCsp
    ? 0
    : Math.max(0, Number(item.cashback ?? previous.cashback ?? 0) || 0);
  const membershipDiscountAmount = isCsp || purchasingMembership
    ? 0
    : Math.max(
        0,
        Number(
          item.membershipDiscountAmount ?? previous.membershipDiscountAmount ?? 0,
        ) || 0,
      );
  const productDiscountAmount = Math.max(
    0,
    Number(item.productDiscountAmount ?? previous.productDiscountAmount ?? 0) || 0,
  );
  return {
    productName: String(item.productName ?? '').trim(),
    qty,
    unitPrice,
    discount,
    lineTotal,
    cashback,
    productDiscountAmount,
    membershipDiscountAmount,
    category: normalizeLineType(item.category || item.lineCategory || 'product'),
    returnedQty: Math.max(0, Number(previous.returnedQty) || 0),
    isGift: Boolean(previous.isGift || item.isGift),
  };
};

const createInvoice = async (req, res) => {
  try {
    const {
      customerName,
      customerPhone,
      customerId: bodyCustomerId,
      invoiceDate,
      dueDate,
      salesPersonName,
      notes,
      items,
      subTotal,
      discountTotal,
      grandTotal,
      status,
      mode,
      paymentStatus,
      paymentBreakdown,
      createdBy,
      pendingAmount,
      coupon,
      referral,
      manualDiscount,
      extraCharges,
      cashbackTotal,
      membershipDiscount,
      activityType,
      membershipType,
      invoiceBy,
      verifiedAt,
    } = req.body;

    console.log(req.body);

    const walletAmount = Number(paymentBreakdown?.wallet ?? 0);
    const normalizedPendingAmount = Number(
      pendingAmount ?? paymentBreakdown?.dueAmount ?? 0,
    );

    if (!customerName || !invoiceDate || !dueDate || !salesPersonName ||!customerPhone) {
      return res.status(400).json({
        success: false,
        message: 'Customer, invoice date, due date, and sales person are required.',
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one invoice item is required.',
      });
    }

    const invoiceDateObj = new Date(invoiceDate);
    const dueDateObj = new Date(dueDate);
    if (Number.isNaN(invoiceDateObj.getTime()) || Number.isNaN(dueDateObj.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid invoice date or due date.',
      });
    }

    if (dueDateObj < getStartOfToday()) {
      return res.status(400).json({
        success: false,
        message: 'Due date cannot be before today.',
      });
    }

    const normalizedItems = items.map(item =>
      normalizeInvoiceItem(item),
    );

    if (normalizedItems.some(item => !item.productName || item.qty <= 0 || item.unitPrice < 0 || item.discount < 0 || item.lineTotal < 0)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid invoice item values.',
      });
    }

    const stockError = await assertSufficientPurchaseStock({
      items: normalizedItems,
    });
    if (stockError) {
      return res.status(400).json(stockError);
    }

    const enrichedItems = await enrichItemsWithCsp(normalizedItems);

    const computedSubTotal = normalizedItems.reduce(
      (sum, item) => sum + Number(item.qty ?? 0) * Number(item.unitPrice ?? 0),
      0,
    );
    const itemDiscountTotal = normalizedItems.reduce(
      (sum, item) => sum + Number(item.discount ?? 0),
      0,
    );

    let appliedCoupon = null;
    let couponDiscount = 0;
    const preCouponAmount = Math.max(0, computedSubTotal - itemDiscountTotal);
    const customer = await findCustomerForInvoice({
      customerId: bodyCustomerId,
      customerPhone,
      customerName,
    });

    if (
      await rejectExpiredMembershipBenefits(res, customer, {
        items,
        membershipDiscount,
        cashbackTotal,
      })
    ) {
      return;
    }

    if (coupon?.code) {
      const couponValidation = await validateCouponForOrder({
        code: coupon.code,
        orderAmount: preCouponAmount,
        customerPhone,
        items: req.body.items || normalizedItems,
      });
      if (!couponValidation.ok) {
        return res.status(400).json({
          success: false,
          message: couponValidation.message,
        });
      }
      appliedCoupon = couponValidation.coupon;
      couponDiscount = Number(couponValidation.discountAmount ?? 0);
    }

    let appliedReferral = null;
    let referralDiscount = 0;
    const preReferralAmount = Math.max(0, preCouponAmount - couponDiscount);
    if (referral?.code || referral?.discountAmount > 0) {
      const referralValidation = await validateReferralDiscountForOrder({
        customerPhone,
        customerId: customer?._id,
        referralCode: referral?.code,
        orderAmount: preReferralAmount > 0 ? preReferralAmount : preCouponAmount,
        items: (req.body.items || normalizedItems).map(item => ({
          productName: item.productName,
          qty: item.qty,
          unitPrice: item.unitPrice,
          discount: item.discount,
          lineTotal: item.lineTotal,
          category: item.category || 'General',
        })),
      });
      if (!referralValidation.ok) {
        // Rule toggled off / no matching segment → skip referral, do not block checkout
        if (!isSoftReferralSkipMessage(referralValidation.message)) {
          return res.status(400).json({
            success: false,
            message: referralValidation.message,
          });
        }
      } else {
        appliedReferral = referralValidation;
        // Buyer discount only on first referral use for the account
        referralDiscount = Number(referralValidation.discountAmount ?? 0);
      }
    }

    const extraChargesTotal = Array.isArray(extraCharges) 
      ? extraCharges.reduce((sum, c) => sum + Number(c.amount ?? 0), 0)
      : 0;

    // Line discounts (membership/item) + coupon + referral.
    // If client also sends invoice-level discountTotal (e.g. membership not on lines),
    // include the remainder so grandTotal matches the POS / Food Bill UI.
    const promoDiscount = couponDiscount + referralDiscount;
    const lineAndPromoDiscount = itemDiscountTotal + promoDiscount;
    const clientDiscountTotal = Number(discountTotal);
    const extraInvoiceDiscount =
      Number.isFinite(clientDiscountTotal) && clientDiscountTotal > lineAndPromoDiscount + 0.001
        ? Math.round((clientDiscountTotal - lineAndPromoDiscount) * 100) / 100
        : 0;
    const computedDiscountTotal = lineAndPromoDiscount + Math.max(0, extraInvoiceDiscount);
    const computedFromParts = Math.max(
      0,
      computedSubTotal - computedDiscountTotal + extraChargesTotal,
    );
    const clientGrandTotal = Number(grandTotal);
    // Prefer client grandTotal when it matches the discounted total (round-off / UI)
    const computedGrandTotal =
      Number.isFinite(clientGrandTotal) &&
      Math.abs(clientGrandTotal - computedFromParts) <= 1
        ? Math.max(0, clientGrandTotal)
        : computedFromParts;

    const nextNumber = await getNextInvoiceNumber();
    const invoicePrefix = 'INVVWAH';
    const invoiceCode = `${invoicePrefix}-${nextNumber}`;
    const actor = buildCreatedBy(req, createdBy);

    if (walletAmount > 0) {
      if (!customer) {
        return res.status(404).json({
          success: false,
          message: 'Customer not found for wallet payment.',
        });
      }

      const existingWallet = await Wallet.findOne({ customerId: customer._id });
      const availableWallet = getSpendableWalletBalance(existingWallet, customer);
      const minimumBalance = await getMinimumWalletBalance();
      const maxPayable = getMaxWalletPaymentAmount(
        availableWallet,
        minimumBalance,
      );
      if (walletAmount > availableWallet + 0.01) {
        return res.status(400).json({
          success: false,
          message: `Insufficient wallet balance. Available: ₹${availableWallet.toFixed(2)}`,
        });
      }
      if (walletAmount > maxPayable + 0.01) {
        return res.status(400).json({
          success: false,
          message:
            `Wallet payment would leave balance below the minimum of ₹${minimumBalance.toFixed(2)}. ` +
            `Available for payment: ₹${maxPayable.toFixed(2)} ` +
            `(balance ₹${availableWallet.toFixed(2)} − minimum ₹${minimumBalance.toFixed(2)}).`,
        });
      }
    }

    const resolvedInvoiceBy = (() => {
      const raw = invoiceBy && typeof invoiceBy === 'object' ? invoiceBy : {};
      const staffId = raw.staffId || raw._id || null;
      const staffName = String(raw.staffName || raw.name || '').trim();
      const employeeId = String(raw.employeeId || raw.m_staff_id || '').trim();
      const email = String(raw.email || '').trim();
      if (!staffName && !staffId) return null;
      return {
        staffId:
          staffId && mongoose.Types.ObjectId.isValid(String(staffId))
            ? String(staffId)
            : null,
        staffName: staffName || String(salesPersonName || '').trim(),
        employeeId,
        email,
      };
    })();

    if (status !== 'draft' && !resolvedInvoiceBy?.staffName) {
      return res.status(400).json({
        success: false,
        message: 'Staff PIN verification is required before creating the invoice.',
      });
    }

    if (status !== 'draft' && String(activityType || '').trim() === 'Space Booking') {
      const tendered = Number(paymentBreakdown?.paidAmount ?? 0);
      const rule = await getBookingPaymentRule();
      const paymentError = bookingPaymentError({
        total: computedGrandTotal,
        paid: Number.isFinite(tendered) ? tendered : 0,
        paymentStatus,
        rule,
      });
      if (paymentError) {
        return res.status(400).json({success: false, message: paymentError});
      }
    }

    const invoice = await Invoice.create({
      invoicePrefix,
      invoiceNumber: nextNumber,
      invoiceCode,
      customerName: String(customerName).trim(),
      customerPhone: String(customerPhone).trim(),
      customerId: customer?._id ?? (bodyCustomerId || null),
      invoiceDate: invoiceDateObj,
      dueDate: dueDateObj,
      salesPersonName: String(
        resolvedInvoiceBy?.staffName || salesPersonName,
      ).trim(),
      invoiceBy: resolvedInvoiceBy || {
        staffId: null,
        staffName: '',
        employeeId: '',
        email: '',
      },
      verifiedAt: verifiedAt
        ? new Date(verifiedAt)
        : resolvedInvoiceBy
          ? new Date()
          : null,
      notes: String(notes ?? '').trim(),
      status: status === 'draft' ? 'draft' : 'final',
      items: enrichedItems,
      subTotal: Number(subTotal ?? computedSubTotal),
      discountTotal: computedDiscountTotal,
      coupon: appliedCoupon
        ? {
            code: appliedCoupon.code,
            title: appliedCoupon.title,
            discountType: appliedCoupon.discountType,
            discountValue: Number(appliedCoupon.discountValue ?? 0),
            discountAmount: couponDiscount,
          }
        : undefined,
      referral: appliedReferral
        ? {
            code: appliedReferral.referralCode,
            inviterName: appliedReferral.inviterName,
            discountType: appliedReferral.discountType,
            discountValue: Number(appliedReferral.discountValue ?? 0),
            discountAmount: referralDiscount,
            label: appliedReferral.label,
          }
        : undefined,
      manualDiscount:
        manualDiscount && Number(manualDiscount.discountAmount) > 0
          ? {
              type: manualDiscount.type === 'percentage' ? 'percentage' : 'flat',
              value: Number(manualDiscount.value || 0),
              discountAmount: Number(manualDiscount.discountAmount || 0),
            }
          : undefined,
      grandTotal: computedGrandTotal,
      extraCharges: Array.isArray(extraCharges) ? extraCharges : [],
      membershipDiscount: (() => {
        const onlyMembershipPurchase =
          Array.isArray(items) &&
          items.length > 0 &&
          items.every(item =>
            isMembershipPurchaseLine(
              item?.category || item?.lineCategory || item?.sourceType,
            ),
          );
        if (onlyMembershipPurchase) return 0;
        const membershipLineDiscount = (Array.isArray(items) ? items : []).reduce(
          (sum, item) => {
            if (
              !isMembershipPurchaseLine(
                item?.category || item?.lineCategory || item?.sourceType,
              )
            ) {
              return sum;
            }
            return (
              sum +
              Math.max(
                0,
                Number(item?.membershipDiscountAmount ?? item?.discount ?? 0) || 0,
              )
            );
          },
          0,
        );
        return Math.max(
          0,
          Number(membershipDiscount ?? 0) - membershipLineDiscount,
        );
      })(),
      membershipType: String(membershipType ?? customer?.membershipType ?? '')
        .trim()
        .toLowerCase(),
      cashbackTotal: Math.max(0, Number(cashbackTotal ?? 0)),
      pendingAmount: normalizedPendingAmount,
      mode: String(mode ?? 'Cash'),
      paymentStatus:
        status === 'draft'
          ? 'partial'
          : paymentStatus === 'due' ||
              (normalizedPendingAmount > 0 &&
                Number(paymentBreakdown?.paidAmount ?? 0) <= 0)
            ? 'due'
            : normalizedPendingAmount > 0 || paymentStatus === 'partial'
              ? 'partial'
              : 'full',
      paymentBreakdown: {
        cash: Number(paymentBreakdown?.cash ?? 0),
        upi: Number(paymentBreakdown?.upi ?? 0),
        card: Number(paymentBreakdown?.card ?? 0),
        wallet: walletAmount,
        paidAmount: (() => {
          const explicit = Number(paymentBreakdown?.paidAmount ?? 0);
          if (explicit > 0) return explicit;
          const parts =
            Number(paymentBreakdown?.cash ?? 0) +
            Number(paymentBreakdown?.upi ?? 0) +
            Number(paymentBreakdown?.card ?? 0) +
            walletAmount;
          if (parts > 0) return parts;
          return Number(computedGrandTotal ?? 0);
        })(),
        dueAmount: normalizedPendingAmount,
        changeAmount: Number(paymentBreakdown?.changeAmount ?? 0),
      },
      createdBy: actor,
    });

    if (walletAmount > 0 && customer) {
      await applyWalletDelta({
        customer,
        invoiceCode,
        amount: walletAmount,
        createdBy: actor,
        note: `Wallet used for invoice ${invoiceCode}`,
      });
    }

    // Post membership cashback to wallet before WhatsApp (idempotent per invoice)
    const cashbackToCredit = Math.max(0, Number(cashbackTotal ?? 0));
    if (
      cashbackToCredit > 0 &&
      customer &&
      invoice.status !== 'draft' &&
      invoice.status !== 'cancelled'
    ) {
      try {
        await creditMembershipCashback({
          customer,
          invoiceCode,
          amount: cashbackToCredit,
          createdBy: actor,
          activityType: resolveActivityType({
            activityType,
            notes,
            items: normalizedItems,
          }),
        });
      } catch (cashbackError) {
        console.error('createInvoice cashback credit error:', cashbackError);
      }
    }

    // CSP 70/30 split — only after payment is fully completed (idempotent)
    try {
      await creditCspsailorShares({
        items: enrichedItems,
        invoiceCode,
        createdBy: actor,
        invoice,
      });
    } catch (cspError) {
      console.error('createInvoice CSP settlement error:', cspError);
    }

    if (
      appliedReferral &&
      invoice.status !== 'cancelled' &&
      invoice.status !== 'draft'
    ) {
      const commissionAmount = Number(
        appliedReferral.commissionAmount ?? referralDiscount ?? 0,
      );
      try {
        if (commissionAmount > 0) {
          await creditReferralDiscountToInviter({
            inviterId: appliedReferral.inviterId,
            referredCustomerId: appliedReferral.buyerId || customer?._id,
            sourceType: 'invoice',
            sourceId: invoiceCode,
            orderAmount: preReferralAmount > 0 ? preReferralAmount : preCouponAmount,
            commissionAmount,
            commissionType: appliedReferral.discountType,
            commissionValue: appliedReferral.discountValue,
            category: appliedReferral.segments?.[0]?.category || 'product',
            segments: appliedReferral.segments,
            buyerName: customer?.name || customerName,
          });
        }
      } catch (creditError) {
        console.error('createInvoice referral commission credit error:', creditError);
      }

      if (referralDiscount > 0 && (appliedReferral.buyerId || customer?._id)) {
        try {
          await markReferralDiscountUsed({
            customerId: appliedReferral.buyerId || customer._id,
            sourceId: invoiceCode,
          });
        } catch (markError) {
          console.error('createInvoice mark referral discount used error:', markError);
        }
      }
    }

    if (appliedCoupon?.code && invoice.status !== 'cancelled') {
      await applyCouponUsageDelta({ code: appliedCoupon.code, delta: 1 });
    }

    // Fire-and-forget WhatsApp activity update (do not block invoice response)
    void notifyActivityUpdateWhatsApp({
      customer,
      customerName,
      customerPhone,
      invoice,
      notes,
      items: normalizedItems,
      activityType,
      membershipDiscount,
      cashbackTotal,
      membershipType,
      // Pass totals explicitly — do not rely on mongoose subdoc timing
      amountPaidOverride: computedGrandTotal,
      subTotalOverride: Number(subTotal ?? computedSubTotal),
    });

    return res.status(201).json({
      success: true,
      message: 'Invoice created successfully.',
      invoice,
    });
  } catch (error) {
    console.error('createInvoice error:', error);
    return res.status(500).json({
      success: false,
      message: 'Invoice creation failed.',
    });
  }
};
const getInvoices=async(req,res)=>{
    try {
        const search = String(req.query.search ?? '').trim();
        const fromDate=String(req.query.fromDate ?? '').trim();
        const toDate=String(req.query.toDate ?? '').trim();
        const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 5000);
        const query = {};
        if (search) {
          const regex = new RegExp(String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
          query.$or = [
            { customerName: regex },
            { customerPhone: regex },
            { invoiceCode: regex },
          ];
        }
        const dateFilter = {};
        if(fromDate){
          const from=new Date(`${fromDate}T00:00:00.000`);
          if(!Number.isNaN(from.getTime())) dateFilter.$gte=from;
        }

        if(toDate){
          const to=new Date(`${toDate}T23:59:59.999`);
          if(!Number.isNaN(to.getTime())) dateFilter.$lte=to;
        }
        if (Object.keys(dateFilter).length) {
          query.invoiceDate = dateFilter;
        }
        const invoices = await Invoice.find(query)
          .sort({createdAt: -1})
          .limit(limit)
          .select(
            'customerName customerPhone pendingAmount paymentBreakdown paymentStatus status invoiceCode createdAt updatedAt grandTotal returnedAmount createdBy mode salesPersonName invoiceDate items coupon referral manualDiscount membershipDiscount membershipType cashbackTotal discountTotal subTotal extraCharges invoiceBy notes',
          )
          .lean();
        return res.status(200).json({
            success: true,
            message: 'Invoices fetched successfully.',
            invoices,
            total: invoices.length,
            limit,
        });
      } catch (error) {
        console.error('getInvoices error:', error);
        return res.status(500).json({
          success: false,
          message: 'Failed to fetch invoices.',
        });
      }
}

const getInvoice = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid invoice id.',
      });
    }
    const invoice = await Invoice.findById(id).lean();
    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found.',
      });
    }
    return res.status(200).json({
      success: true,
      invoice,
    });
  } catch (error) {
    console.error('getInvoice error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch invoice.',
    });
  }
};

const deleteInvoice = async (req, res) => {
  try {
    const { id } = req.params;
    console.log(id);

    // check if id exists
    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Invoice ID is required",
      });
    }

    const invoice = await Invoice.findById(id);

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    const walletAmount = Number(invoice.paymentBreakdown?.wallet ?? 0);
    const customer = await findCustomerForInvoice({
      customerId: invoice.customerId,
      customerPhone: invoice.customerPhone,
      customerName: invoice.customerName,
    });
    if (walletAmount > 0 && customer) {
      await applyWalletDelta({
        customer,
        invoiceCode: invoice.invoiceCode,
        amount: -walletAmount,
        createdBy: buildCreatedBy(req),
        note: `Wallet refunded for deleted invoice ${invoice.invoiceCode}`,
      });
    }

    const cashbackLeft = remainingCashbackToReverse(invoice);
    if (cashbackLeft > 0 && customer) {
      try {
        const result = await reverseMembershipCashback({
          customer,
          amount: cashbackLeft,
          invoiceCode: invoice.invoiceCode,
          referenceId: `${invoice.invoiceCode}:cashback-delete`,
          note: `Cashback reversed — invoice ${invoice.invoiceCode} deleted`,
          createdBy: buildCreatedBy(req),
        });
        if (result.reversed > 0) {
          invoice.cashbackReversedTotal = roundMoney(
            Number(invoice.cashbackReversedTotal || 0) + result.reversed,
          );
          await invoice.save();
        }
      } catch (cbError) {
        console.error('deleteInvoice cashback reverse error:', cbError);
      }
    }

    if (invoice.status !== 'cancelled' && invoice.coupon?.code) {
      await applyCouponUsageDelta({ code: invoice.coupon.code, delta: -1 });
    }

    try {
      await reverseCspsailorShares({
        invoice,
        createdBy: buildCreatedBy(req),
      });
    } catch (cspError) {
      console.error('deleteInvoice CSP reverse error:', cspError);
    }

    const deletedInvoice = await Invoice.findOneAndDelete({ _id: id });

    return res.status(200).json({
      success: true,
      message: "Invoice deleted successfully",
      deletedInvoice,
    });

  } catch (error) {
    console.error("deleteInvoice error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to delete invoice",
    });
  }
};

const updateInvoice = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, message: "Invoice ID is required" });
    }

    const {
      customerName,
      customerPhone,
      customerId: bodyCustomerId,
      invoiceDate,
      dueDate,
      salesPersonName,
      notes,
      items,
      subTotal,
      discountTotal,
      grandTotal,
      status,
      mode,
      paymentStatus,
      paymentBreakdown,
      createdBy,
      coupon,
      newPayment,
      extraCharges,
      invoiceBy,
      verifiedAt,
    } = req.body;

    const existingInvoice = await Invoice.findById(id);
    if (!existingInvoice) {
      return res.status(404).json({ success: false, message: "Invoice not found" });
    }

    const resolvedCustomer = await findCustomerForInvoice({
      customerId: bodyCustomerId ?? existingInvoice.customerId,
      customerPhone: customerPhone ?? existingInvoice.customerPhone,
      customerName: customerName ?? existingInvoice.customerName,
    });

    if (
      await rejectExpiredMembershipBenefits(
        res,
        resolvedCustomer,
        {
          items,
          membershipDiscount: req.body?.membershipDiscount,
          cashbackTotal: req.body?.cashbackTotal,
        },
        {
          items: existingInvoice.items,
          membershipDiscount: existingInvoice.membershipDiscount,
          cashbackTotal: existingInvoice.cashbackTotal,
        },
      )
    ) {
      return;
    }

    const invoiceDateObj = invoiceDate ? new Date(invoiceDate) : undefined;
    const dueDateObj = dueDate ? new Date(dueDate) : undefined;

    let normalizedItems;
    if (items && Array.isArray(items)) {
      const existingItems = Array.isArray(existingInvoice.items) ? existingInvoice.items : [];
      normalizedItems = items.map((item, idx) => {
        const previous = existingItems[idx] || {};
        return normalizeInvoiceItem(item, previous);
      });
    }

    if (normalizedItems && normalizedItems.length) {
      const stockError = await assertSufficientPurchaseStock({
        items: normalizedItems,
        excludeInvoiceId: id,
      });
      if (stockError) {
        return res.status(400).json(stockError);
      }
      normalizedItems = await enrichItemsWithCsp(normalizedItems);
    }

    const updateData = {};
    if (customerName !== undefined) updateData.customerName = String(customerName).trim();
    if (customerPhone !== undefined) updateData.customerPhone = String(customerPhone).trim();
    if (bodyCustomerId !== undefined || resolvedCustomer?._id) {
      updateData.customerId =
        resolvedCustomer?._id ??
        (bodyCustomerId
          ? mongoose.Types.ObjectId.isValid(String(bodyCustomerId))
            ? bodyCustomerId
            : null
          : existingInvoice.customerId);
    }
    if (invoiceDateObj !== undefined) updateData.invoiceDate = invoiceDateObj;
    if (dueDateObj !== undefined) updateData.dueDate = dueDateObj;
    if (salesPersonName !== undefined) updateData.salesPersonName = String(salesPersonName).trim();
    if (invoiceBy !== undefined) {
      const raw = invoiceBy && typeof invoiceBy === 'object' ? invoiceBy : {};
      updateData.invoiceBy = {
        staffId:
          raw.staffId && mongoose.Types.ObjectId.isValid(String(raw.staffId))
            ? String(raw.staffId)
            : null,
        staffName: String(raw.staffName || raw.name || '').trim(),
        employeeId: String(raw.employeeId || raw.m_staff_id || '').trim(),
        email: String(raw.email || '').trim(),
      };
      if (updateData.invoiceBy.staffName && !verifiedAt) {
        updateData.verifiedAt = new Date();
      }
    }
    if (verifiedAt !== undefined) {
      updateData.verifiedAt = verifiedAt ? new Date(verifiedAt) : null;
    }
    if (notes !== undefined) updateData.notes = String(notes).trim();
    if (normalizedItems !== undefined) updateData.items = normalizedItems;
    if (subTotal !== undefined) updateData.subTotal = Number(subTotal);
    if (discountTotal !== undefined) updateData.discountTotal = Number(discountTotal);
    if (extraCharges !== undefined) updateData.extraCharges = Array.isArray(extraCharges) ? extraCharges : [];
    if (grandTotal !== undefined) updateData.grandTotal = Number(grandTotal);
    if (status !== undefined) updateData.status = status;
    if (mode !== undefined) updateData.mode = String(mode);
    if (paymentStatus !== undefined) updateData.paymentStatus = paymentStatus;
    if (paymentBreakdown !== undefined) {
      updateData.paymentBreakdown = {
        cash: Number(paymentBreakdown?.cash ?? 0),
        upi: Number(paymentBreakdown?.upi ?? 0),
        card: Number(paymentBreakdown?.card ?? 0),
        wallet: Number(paymentBreakdown?.wallet ?? 0),
        paidAmount: Number(paymentBreakdown?.paidAmount ?? 0),
        dueAmount: Number(paymentBreakdown?.dueAmount ?? 0),
        changeAmount: Number(paymentBreakdown?.changeAmount ?? 0),
      };
      updateData.pendingAmount = Number(paymentBreakdown?.dueAmount ?? 0);
    }
    if (req.body?.cashbackTotal !== undefined) {
      updateData.cashbackTotal = Math.max(0, Number(req.body.cashbackTotal) || 0);
    }
    if (req.body?.membershipDiscount !== undefined) {
      updateData.membershipDiscount = Math.max(
        0,
        Number(req.body.membershipDiscount) || 0,
      );
    }
    if (req.body?.pendingAmount !== undefined) {
      updateData.pendingAmount = Math.max(0, Number(req.body.pendingAmount) || 0);
    }

    let nextCouponPatch;
    if (coupon !== undefined) {
      if (!coupon?.code) {
        nextCouponPatch = {
          code: null,
          title: null,
          discountType: null,
          discountValue: 0,
          discountAmount: 0,
        };
      } else {
        const extraChargesTotal = Array.isArray(updateData.extraCharges ?? existingInvoice.extraCharges)
          ? (updateData.extraCharges ?? existingInvoice.extraCharges).reduce((sum, c) => sum + Number(c.amount ?? 0), 0)
          : 0;

        const couponValidation = await validateCouponForOrder({
          code: coupon.code,
          orderAmount: Number(updateData.subTotal ?? existingInvoice.subTotal) - Number(updateData.discountTotal ?? existingInvoice.discountTotal ?? 0) + extraChargesTotal,
          customerPhone: String(updateData.customerPhone ?? existingInvoice.customerPhone ?? '').trim(),
          ignoreInvoiceId: id,
          items: updateData.items ?? existingInvoice.items,
        });
        if (!couponValidation.ok) {
          return res.status(400).json({
            success: false,
            message: couponValidation.message,
          });
        }
        nextCouponPatch = {
          code: couponValidation.coupon.code,
          title: couponValidation.coupon.title,
          discountType: couponValidation.coupon.discountType,
          discountValue: Number(couponValidation.coupon.discountValue ?? 0),
          discountAmount: Number(couponValidation.discountAmount ?? 0),
        };
      }
      updateData.coupon = nextCouponPatch;
    }

    const nextCustomerName =
      updateData.customerName ?? existingInvoice.customerName;
    const nextCustomerPhone =
      updateData.customerPhone ?? existingInvoice.customerPhone;
    const nextInvoiceCode = existingInvoice.invoiceCode;
    const previousWalletAmount = Number(existingInvoice.paymentBreakdown?.wallet ?? 0);
    const nextWalletAmount = Number(
      updateData.paymentBreakdown?.wallet ?? existingInvoice.paymentBreakdown?.wallet ?? 0,
    );
    const walletDelta = nextWalletAmount - previousWalletAmount;
    const actor = buildCreatedBy(req, createdBy);
    const previousCouponCode = String(existingInvoice.coupon?.code ?? '').trim().toUpperCase();
    const nextCouponCode = String(updateData.coupon?.code ?? existingInvoice.coupon?.code ?? '').trim().toUpperCase();

    if (walletDelta !== 0) {
      const customer = await findCustomerForInvoice({
        customerPhone: nextCustomerPhone,
        customerName: nextCustomerName,
      });
      if (!customer) {
        return res.status(404).json({
          success: false,
          message: "Customer not found for wallet update.",
        });
      }

      const wallet = await Wallet.findOne({ customerId: customer._id });
      const availableWallet = getSpendableWalletBalance(wallet, customer);
      if (walletDelta > 0 && walletDelta > availableWallet + 0.01) {
        return res.status(400).json({
          success: false,
          message: `Insufficient wallet balance. Available: ₹${availableWallet.toFixed(2)}`,
        });
      }

      await applyWalletDelta({
        customer,
        invoiceCode: nextInvoiceCode,
        amount: walletDelta,
        createdBy: actor,
        note:
          walletDelta > 0
            ? `Additional wallet used for invoice ${nextInvoiceCode}`
            : `Wallet refunded on invoice update ${nextInvoiceCode}`,
      });
    }

    const updateQuery = { $set: updateData };
    if (newPayment) {
      updateQuery.$push = { paymentHistory: newPayment };
    }

    const updatedInvoice = await Invoice.findByIdAndUpdate(
      id,
      updateQuery,
      { new: true }
    );

    if (existingInvoice.status !== 'cancelled' && previousCouponCode && previousCouponCode !== nextCouponCode) {
      await applyCouponUsageDelta({ code: previousCouponCode, delta: -1 });
    }
    if (
      (updateData.status ?? existingInvoice.status) !== 'cancelled' &&
      nextCouponCode &&
      previousCouponCode !== nextCouponCode
    ) {
      await applyCouponUsageDelta({ code: nextCouponCode, delta: 1 });
    }

    // When due payment is cleared, settle CSP 70/30 split
    try {
      await creditCspsailorShares({
        invoice: updatedInvoice,
        items: updatedInvoice?.items,
        invoiceCode: updatedInvoice?.invoiceCode,
        createdBy: actor,
      });
    } catch (cspError) {
      console.error('updateInvoice CSP settlement error:', cspError);
    }

    return res.status(200).json({
      success: true,
      message: "Invoice updated successfully",
      invoice: updatedInvoice,
    });
  } catch (error) {
    console.error("updateInvoice error:", error);
    return res.status(500).json({ success: false, message: "Failed to update invoice" });
  }
};

const cancelInvoice = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, message: "Invoice ID is required" });
    }

    const invoice = await Invoice.findById(id);
    if (!invoice) {
      return res.status(404).json({ success: false, message: "Invoice not found" });
    }
    if (invoice.status === 'cancelled') {
      return res.status(200).json({
        success: true,
        message: "Invoice already cancelled",
        invoice,
      });
    }

    const walletAmount = Number(invoice.paymentBreakdown?.wallet ?? 0);
    const customer = await findCustomerForInvoice({
      customerId: invoice.customerId,
      customerPhone: invoice.customerPhone,
      customerName: invoice.customerName,
    });
    if (walletAmount > 0 && customer) {
      await applyWalletDelta({
        customer,
        invoiceCode: invoice.invoiceCode,
        amount: -walletAmount,
        createdBy: buildCreatedBy(req),
        note: `Wallet refunded for cancelled invoice ${invoice.invoiceCode}`,
      });
    }

    const cashbackLeft = remainingCashbackToReverse(invoice);
    if (cashbackLeft > 0 && customer) {
      try {
        const result = await reverseMembershipCashback({
          customer,
          amount: cashbackLeft,
          invoiceCode: invoice.invoiceCode,
          referenceId: `${invoice.invoiceCode}:cashback-cancel`,
          note: `Cashback reversed — invoice ${invoice.invoiceCode} cancelled`,
          createdBy: buildCreatedBy(req),
        });
        if (result.reversed > 0) {
          invoice.cashbackReversedTotal = roundMoney(
            Number(invoice.cashbackReversedTotal || 0) + result.reversed,
          );
        }
      } catch (cbError) {
        console.error('cancelInvoice cashback reverse error:', cbError);
      }
    }

    if (invoice.coupon?.code) {
      await applyCouponUsageDelta({ code: invoice.coupon.code, delta: -1 });
    }

    try {
      await reverseCspsailorShares({
        invoice,
        createdBy: buildCreatedBy(req),
      });
    } catch (cspError) {
      console.error('cancelInvoice CSP reverse error:', cspError);
    }

    invoice.status = 'cancelled';
    const updatedInvoice = await invoice.save();

    return res.status(200).json({
      success: true,
      message: "Invoice cancelled successfully",
      invoice: updatedInvoice,
    });
  } catch (error) {
    console.error("cancelInvoice error:", error);
    return res.status(500).json({ success: false, message: "Failed to cancel invoice" });
  }
};

export { createInvoice, getInvoices, getInvoice, deleteInvoice, updateInvoice, cancelInvoice };


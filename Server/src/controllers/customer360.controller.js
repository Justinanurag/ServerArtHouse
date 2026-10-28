import mongoose from 'mongoose';
import Customer from '../models/customer.model.js';
import Invoice from '../models/invoice.model.js';
import SpaceBooking from '../models/spaceBooking.model.js';
import AllBooking from '../models/allBooking.model.js';
import Subscription from '../models/subscription.model.js';
import Membership from '../models/membership.model.js';
import Wallet from '../models/wallet.model.js';
import {cspProgramForCustomer} from './csp.controller.js';

const LIMIT = 250;
const CLOSED = new Set(['cancelled', 'draft', 'expired']);

const roundMoney = value => Math.round((Number(value) || 0) * 100) / 100;

const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const digits = value => String(value || '').replace(/\D/g, '').slice(-10);

const phoneClause = phone => {
  if (phone.length < 10) return null;
  return new RegExp(phone.split('').join('\\D*'));
};

const identityMatch = (customer, {idField = 'customerId'} = {}) => {
  const clauses = [];
  if (customer._id && idField) clauses.push({[idField]: customer._id});
  const phone = digits(customer.mobile);
  const pattern = phoneClause(phone);
  if (pattern) clauses.push({customerPhone: pattern});
  const name = String(customer.name || '').trim();
  if (name) clauses.push({customerName: new RegExp(`^${escapeRegex(name)}$`, 'i')});
  if (!clauses.length) return {_id: null};
  return {$or: clauses};
};

const isCounted = status => !CLOSED.has(String(status || '').trim().toLowerCase());

const periodEnd = (start, periodRaw) => {
  const end = new Date(start);
  const period = String(periodRaw || 'Yearly').trim().toLowerCase();
  if (period.includes('lifetime')) end.setFullYear(end.getFullYear() + 100);
  else if (period.includes('month')) end.setMonth(end.getMonth() + 1);
  else end.setFullYear(end.getFullYear() + 1);
  return end;
};

const membershipMonths = doc => {
  if (doc.repeatType === 'lifetime') return null;
  if (doc.startDate && doc.endDate) {
    const start = new Date(doc.startDate);
    const end = new Date(doc.endDate);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      const months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
      return Math.max(months, 1);
    }
  }
  if (doc.repeatType === 'yearly' || doc.repeatUnit === 'year') return (Number(doc.repeatEvery) || 1) * 12;
  if (doc.repeatType === 'weekly') return null;
  return Number(doc.repeatEvery) || 1;
};

const mapPurchase = doc => {
  const amount = roundMoney(doc.grandTotal);
  const due = roundMoney(doc.pendingAmount ?? doc.paymentBreakdown?.dueAmount);
  const paid = roundMoney(
    doc.paymentBreakdown?.paidAmount ?? Math.max(0, amount - due),
  );
  const items = (doc.items || []).map(item => ({
    name: item.productName || '',
    qty: Number(item.qty) || 0,
    unitPrice: roundMoney(item.unitPrice),
    discount: roundMoney(item.discount),
    lineTotal: roundMoney(item.lineTotal),
  }));
  return {
    id: String(doc._id),
    code: doc.invoiceCode || '',
    invoiceDate: doc.invoiceDate || doc.createdAt || null,
    createdAt: doc.createdAt || null,
    amount,
    subTotal: roundMoney(doc.subTotal),
    paidAmount: paid,
    dueAmount: due,
    discountTotal: roundMoney(doc.discountTotal),
    membershipDiscount: roundMoney(doc.membershipDiscount),
    couponDiscount: roundMoney(doc.coupon?.discountAmount),
    referralDiscount: roundMoney(doc.referral?.discountAmount),
    manualDiscount: roundMoney(doc.manualDiscount?.discountAmount),
    membershipType: doc.membershipType || '',
    status: doc.status || '',
    paymentStatus: doc.paymentStatus || '',
    mode: doc.mode || '',
    items,
    payment: {
      cash: roundMoney(doc.paymentBreakdown?.cash),
      upi: roundMoney(doc.paymentBreakdown?.upi),
      card: roundMoney(doc.paymentBreakdown?.card),
      wallet: roundMoney(doc.paymentBreakdown?.wallet),
      paidAmount: paid,
      dueAmount: due,
      changeAmount: roundMoney(doc.paymentBreakdown?.changeAmount),
    },
    paymentHistory: (doc.paymentHistory || []).map(row => ({
      date: row.date || null,
      amount: roundMoney(row.amount),
      mode: row.mode || '',
      receivedBy: row.receivedBy || '',
    })),
  };
};

const mapBooking = (doc, kind) => ({
  id: String(doc._id),
  kind,
  code: doc.bookingCode || '',
  title: doc.spaceName || (kind === 'full' ? 'Full booking' : 'Space booking'),
  bookingDate: doc.bookingDate || doc.createdAt || null,
  startTime: doc.startTime || '',
  endTime: doc.endTime || '',
  createdAt: doc.createdAt || null,
  amount: roundMoney(doc.grandTotal),
  paidAmount: roundMoney(doc.paidAmount),
  dueAmount: roundMoney(doc.dueAmount),
  status: doc.status || '',
});

const mapMembership = doc => ({
  id: String(doc._id),
  code: doc.subscriptionCode || '',
  plan: doc.membershipType || '',
  status: doc.status || '',
  startDate: doc.startDate || doc.invoiceDate || null,
  endDate: doc.endDate || null,
  invoiceDate: doc.invoiceDate || doc.createdAt || null,
  createdAt: doc.createdAt || null,
  amount: roundMoney(doc.grandTotal),
  paymentStatus: doc.paymentStatus || '',
  months: membershipMonths(doc),
  term: doc.repeatType || '',
});

const mapWalletTx = (tx, index) => ({
  id: tx._id ? String(tx._id) : `wallet-${index}`,
  type: tx.type || '',
  amount: roundMoney(tx.amount),
  walletType: tx.walletType || '',
  reason: tx.reason || '',
  note: tx.note || '',
  balanceAfter: roundMoney(tx.closingBalance ?? tx.totalBalanceAfter),
  createdAt: tx.createdAt || null,
  by: tx.createdBy?.m_staff_name || '',
});

export const getCustomer360 = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid customer id.'});
    }
    const customer = await Customer.findById(id)
      .select(
        'name mobile email whatsappNumber AlternateMobile companyName gstin address city state pincode country membershipType membershipPlanId priority walletAmount closingBalance cashbackBalance affiliateBalance withdrawable nonWithdrawable referralCode status createdAt membershipPurchase profileImage',
      )
      .lean();
    if (!customer) {
      return res.status(404).json({success: false, message: 'Customer not found.'});
    }

    const byIdentity = identityMatch(customer);
    const byContact = identityMatch(customer, {idField: ''});
    const [invoices, spaceBookings, fullBookings, subscriptions, wallet] = await Promise.all([
      Invoice.find(byIdentity)
        .select('invoiceCode invoiceDate grandTotal subTotal discountTotal membershipDiscount coupon referral manualDiscount membershipType pendingAmount paymentStatus status mode items paymentBreakdown paymentHistory createdAt')
        .sort({createdAt: -1})
        .limit(LIMIT)
        .lean(),
      SpaceBooking.find(byContact)
        .select('spaceName bookingDate startTime endTime status grandTotal paidAmount dueAmount createdAt')
        .sort({createdAt: -1})
        .limit(LIMIT)
        .lean(),
      AllBooking.find(byIdentity)
        .select('bookingCode spaceName bookingDate startTime endTime status grandTotal paidAmount dueAmount createdAt')
        .sort({createdAt: -1})
        .limit(LIMIT)
        .lean(),
      Subscription.find(byContact)
        .select('subscriptionCode membershipType status startDate endDate invoiceDate grandTotal paymentStatus repeatType repeatEvery repeatUnit createdAt')
        .sort({createdAt: -1})
        .limit(LIMIT)
        .lean(),
      Wallet.findOne({customerId: customer._id}).select('walletAmount transactions').lean(),
    ]);

    const purchases = invoices.map(mapPurchase);
    const bookings = [
      ...fullBookings.map(row => mapBooking(row, 'full')),
      ...spaceBookings.map(row => mapBooking(row, 'space')),
    ].sort((a, b) => new Date(b.createdAt || b.bookingDate || 0) - new Date(a.createdAt || a.bookingDate || 0));
    const memberships = subscriptions.map(mapMembership);
    const planKey = String(customer.membershipType || '').trim().toLowerCase();
    let currentMembership = memberships.find(
      row => String(row.plan || '').trim().toLowerCase() === planKey && isCounted(row.status),
    ) || null;
    if (planKey && planKey !== 'none' && !currentMembership) {
      const planId = customer.membershipPlanId;
      const plan = mongoose.Types.ObjectId.isValid(planId)
        ? await Membership.findById(planId).select('displayName planId pricing').lean()
        : await Membership.findOne({planId: planKey}).select('displayName planId pricing').lean();
      const start = customer.membershipPurchase?.purchasedAt || customer.createdAt || null;
      const end = start ? periodEnd(start, plan?.pricing?.period) : null;
      const term = String(plan?.pricing?.period || 'yearly').toLowerCase().includes('lifetime')
        ? 'lifetime'
        : String(plan?.pricing?.period || '').toLowerCase().includes('month')
          ? 'monthly'
          : 'yearly';
      currentMembership = {
        id: `current-${customer._id}`,
        code: 'Current',
        plan: plan?.displayName || customer.membershipType,
        status: end && new Date(end).getTime() < Date.now() ? 'expired' : 'active',
        startDate: start,
        endDate: term === 'lifetime' ? null : end,
        invoiceDate: start,
        createdAt: start,
        amount: roundMoney(customer.membershipPurchase?.paidAmount ?? plan?.pricing?.amount),
        paymentStatus: customer.membershipPurchase?.paidAmount != null ? 'Paid' : '',
        months: term === 'monthly' ? 1 : term === 'yearly' ? 12 : null,
        term,
        current: true,
      };
      memberships.unshift(currentMembership);
    } else if (currentMembership) {
      currentMembership.current = true;
    }
    const walletTransactions = (wallet?.transactions || [])
      .map(mapWalletTx)
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .slice(0, LIMIT);

    const openPurchases = purchases.filter(row => isCounted(row.status));
    const openBookings = bookings.filter(row => isCounted(row.status));
    const purchaseTotal = roundMoney(openPurchases.reduce((sum, row) => sum + row.amount, 0));
    const purchaseDue = roundMoney(openPurchases.reduce((sum, row) => sum + row.dueAmount, 0));
    const bookingTotal = roundMoney(openBookings.reduce((sum, row) => sum + row.amount, 0));
    const credits = roundMoney(
      walletTransactions.filter(row => row.type === 'credit').reduce((sum, row) => sum + row.amount, 0),
    );
    const debits = roundMoney(
      walletTransactions.filter(row => row.type === 'debit').reduce((sum, row) => sum + row.amount, 0),
    );

    const timeline = [
      {
        id: `created-${customer._id}`,
        type: 'customer',
        title: 'Customer created',
        detail: customer.name || '',
        amount: 0,
        products: [],
        discount: 0,
        credit: 0,
        debit: 0,
        months: null,
        paymentMode: '',
        paidAmount: 0,
        dueAmount: 0,
        at: customer.createdAt,
        createdAt: customer.createdAt,
      },
      ...purchases.map(row => ({
        id: `sale-${row.id}`,
        type: 'sale',
        title: `Product sale ${row.code || ''}`.trim(),
        detail: row.items.map(item => item.name).filter(Boolean).join(', '),
        amount: row.amount,
        products: row.items.map(item => item.name).filter(Boolean),
        discount: row.discountTotal,
        credit: 0,
        debit: 0,
        months: null,
        paymentMode: row.mode,
        paidAmount: row.paidAmount,
        dueAmount: row.dueAmount,
        at: row.invoiceDate,
        createdAt: row.createdAt,
      })),
      ...purchases.flatMap(row =>
        row.paymentHistory.map((payment, index) => ({
          id: `payment-${row.id}-${index}`,
          type: 'payment',
          title: `Payment on ${row.code || 'invoice'}`,
          detail: payment.receivedBy ? `Received by ${payment.receivedBy}` : '',
          amount: payment.amount,
          products: [],
          discount: 0,
          credit: 0,
          debit: 0,
          months: null,
          paymentMode: payment.mode,
          paidAmount: payment.amount,
          dueAmount: 0,
          at: payment.date || row.invoiceDate,
          createdAt: payment.date || row.createdAt,
        })),
      ),
      ...bookings.map(row => ({
        id: `booking-${row.kind}-${row.id}`,
        type: 'booking',
        title: row.title,
        detail: `${row.kind === 'full' ? 'Full booking' : 'Space booking'}${row.status ? ` · ${row.status}` : ''}`,
        amount: row.amount,
        products: [],
        discount: 0,
        credit: 0,
        debit: 0,
        months: null,
        paymentMode: '',
        paidAmount: row.paidAmount,
        dueAmount: row.dueAmount,
        at: row.bookingDate,
        createdAt: row.createdAt,
      })),
      ...memberships.map(row => ({
        id: `membership-${row.id}`,
        type: 'membership',
        title: `Membership ${row.plan || row.code}`.trim(),
        detail: row.status,
        amount: row.amount,
        products: [],
        discount: 0,
        credit: 0,
        debit: 0,
        months: row.months,
        paymentMode: '',
        paidAmount: row.amount,
        dueAmount: 0,
        at: row.startDate || row.invoiceDate,
        createdAt: row.createdAt,
      })),
      ...walletTransactions.map(row => ({
        id: `wallet-${row.id}`,
        type: 'wallet',
        title: row.reason || row.walletType || 'Wallet',
        detail: row.note || '',
        amount: row.amount,
        products: [],
        discount: 0,
        credit: row.type === 'credit' ? row.amount : 0,
        debit: row.type === 'debit' ? row.amount : 0,
        months: null,
        paymentMode: '',
        paidAmount: 0,
        dueAmount: 0,
        at: row.createdAt,
        createdAt: row.createdAt,
      })),
    ]
      .filter(row => row.at || row.createdAt)
      .sort((a, b) => new Date(b.createdAt || b.at) - new Date(a.createdAt || a.at));

    return res.status(200).json({
      success: true,
      customer,
      summary: {
        purchaseTotal,
        purchaseCount: openPurchases.length,
        purchaseDue,
        bookingTotal,
        bookingCount: openBookings.length,
        membershipCount: memberships.filter(row => isCounted(row.status)).length,
        currentMembership,
        walletBalance: roundMoney(customer.walletAmount ?? wallet?.walletAmount),
        walletCredits: credits,
        walletDebits: debits,
      },
      purchases,
      bookings,
      memberships,
      walletTransactions,
      timeline,
      program: {
        csp: await cspProgramForCustomer(customer._id),
        hap: {enrolled: false},
      },
    });
  } catch (error) {
    console.error('getCustomer360 error:', error);
    return res.status(500).json({success: false, message: error.message || 'Could not load customer 360.'});
  }
};

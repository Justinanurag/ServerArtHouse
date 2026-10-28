import mongoose from 'mongoose';
import Customer from '../models/customer.model.js';
import Wallet from '../models/wallet.model.js';
import Product from '../models/product.model.js';
import Invoice from '../models/invoice.model.js';
import CustomerSailorProgram from '../models/customerSellerProgram.model.js';
import CspSettlement from '../models/cspSettlement.model.js';
import {appendTransaction} from '../controllers/wallet.controller.js';
import {sendCspSaleUpdateWhatsApp} from '../modules/customer/services/whatsapp.service.js';

export const getCspsailorSharePercent = () => {
  const n = Number(process.env.CSP_sailor_SHARE_PERCENT ?? 70);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 70;
};

export const getCspPlatformSharePercent = () => {
  const n = Number(process.env.CSP_PLATFORM_SHARE_PERCENT ?? 30);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : 30;
};

export const roundMoney = value => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
};

/** Catalogue / POS lines use "Parent - Variant"; Product.productName is parent only. */
export const splitCatalogueLineName = productName => {
  const raw = String(productName || '').trim();
  const idx = raw.indexOf(' - ');
  if (idx <= 0) return {parent: raw, variant: ''};
  return {
    parent: raw.slice(0, idx).trim(),
    variant: raw.slice(idx + 3).trim(),
  };
};

const nameKey = value => String(value || '').trim().toLowerCase();

const extractProductObjectId = value => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const base = raw.includes('::') ? raw.split('::')[0] : raw;
  return mongoose.Types.ObjectId.isValid(base) ? base : null;
};

/** Payment must be fully collected before CSP 70/30 split runs. */
export const isInvoicePaymentComplete = invoice => {
  if (!invoice) return false;
  const status = String(invoice.status || '').toLowerCase();
  if (status === 'draft' || status === 'cancelled') return false;

  const pending = Number(
    invoice.pendingAmount ?? invoice.paymentBreakdown?.dueAmount ?? 0,
  );
  if (pending > 0.001) return false;

  const ps = String(invoice.paymentStatus || '').toLowerCase();
  if (ps === 'due' || ps === 'partial') return false;

  return true;
};

const isCspSaleCredit = (tx, invoiceCode) =>
  String(tx.referenceId || '').trim() === String(invoiceCode || '').trim() &&
  String(tx.type || '').toLowerCase() === 'credit' &&
  String(tx.referenceType || '') === 'CspSale';

const formatInvoiceLabel = invoice => {
  const code = String(invoice?.invoiceCode || '').trim();
  const number = invoice?.invoiceNumber;
  return Number.isFinite(Number(number)) && Number(number) > 0
    ? `Invoice #${Number(number)}`
    : code || 'Invoice';
};

const buildCspEarningNote = ({invoice, productNames = []}) => {
  const invoiceLabel = formatInvoiceLabel(invoice);
  const productLabel = productNames.filter(Boolean).slice(0, 3).join(', ');
  return productLabel
    ? `CSP Product Earning · ${invoiceLabel} · ${productLabel}`
    : `CSP Product Earning · ${invoiceLabel}`;
};

/** Attach CSP metadata onto normalized invoice lines from Product catalogue. */
export const enrichItemsWithCsp = async items => {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return items;

  const lineNames = [
    ...new Set(
      list.map(i => String(i.productName || '').trim()).filter(Boolean),
    ),
  ];
  const parentNames = [
    ...new Set(
      lineNames
        .map(n => splitCatalogueLineName(n).parent)
        .map(n => String(n || '').trim())
        .filter(Boolean),
    ),
  ];
  const productIds = [
    ...new Set(
      list
        .map(i => extractProductObjectId(i.productId || i.sourceId || i._id))
        .filter(Boolean),
    ),
  ];

  const nameCandidates = [...new Set([...lineNames, ...parentNames])];
  if (!nameCandidates.length && !productIds.length) return items;

  const orFilters = [];
  if (nameCandidates.length) {
    orFilters.push({productName: {$in: nameCandidates}, isCsp: true});
  }
  if (productIds.length) {
    orFilters.push({_id: {$in: productIds}, isCsp: true});
  }

  const products = await Product.find({$or: orFilters})
    .select(
      '_id productName isCsp cspEnrollmentId cspCustomerId cspVendorId variants',
    )
    .lean();

  /**
   * Map every catalogue display form → product:
   * - exact parent name
   * - "Parent - Variant" (how POS/catalogue stores invoice lines)
   */
  const byName = new Map();
  const byId = new Map();
  for (const product of products) {
    byId.set(String(product._id), product);
    const parent = String(product.productName || '').trim();
    if (parent) {
      byName.set(nameKey(parent), product);
      const variants = Array.isArray(product.variants) ? product.variants : [];
      for (const variant of variants) {
        const variantName = String(variant?.name || '').trim();
        if (!variantName) continue;
        byName.set(nameKey(`${parent} - ${variantName}`), product);
      }
    }
  }

  const enrollmentIds = [
    ...new Set(
      products
        .map(p => (p.cspEnrollmentId ? String(p.cspEnrollmentId) : ''))
        .filter(Boolean),
    ),
  ];
  const enrollments = enrollmentIds.length
    ? await CustomerSailorProgram.find({
        _id: {$in: enrollmentIds},
        status: 'active',
      })
        .select(
          '_id customerId vendorId sailorSharePercent platformSharePercent status',
        )
        .lean()
    : [];
  const enrollmentMap = new Map(enrollments.map(e => [String(e._id), e]));

  const defaultSailorShare = getCspsailorSharePercent();
  const defaultPlatformShare = getCspPlatformSharePercent();

  const nonCspLine = (item, productId = null) => ({
    ...item,
    productId: productId || item.productId || null,
    isCsp: false,
    cspEnrollmentId: null,
    cspCustomerId: null,
    cspsailorAmount: 0,
    cspPlatformAmount: 0,
  });

  return list.map(rawItem => {
    const item =
      rawItem && typeof rawItem.toObject === 'function'
        ? rawItem.toObject()
        : {...rawItem};
    const lineName = String(item.productName || '').trim();
    const productIdHint = extractProductObjectId(
      item.productId || item.sourceId || item._id,
    );
    const product =
      (productIdHint ? byId.get(String(productIdHint)) : null) ||
      byName.get(nameKey(lineName)) ||
      byName.get(nameKey(splitCatalogueLineName(lineName).parent)) ||
      null;

    if (!product?.isCsp) {
      return nonCspLine(item);
    }

    const enrollment = product.cspEnrollmentId
      ? enrollmentMap.get(String(product.cspEnrollmentId))
      : null;
    if (!enrollment) {
      return nonCspLine(item, product._id);
    }

    const sailorShare = Number.isFinite(Number(enrollment.sailorSharePercent))
      ? Number(enrollment.sailorSharePercent)
      : defaultSailorShare;
    const platformShare = Number.isFinite(
      Number(enrollment.platformSharePercent),
    )
      ? Number(enrollment.platformSharePercent)
      : Math.max(0, 100 - sailorShare) || defaultPlatformShare;

    // CSP products are membership-discount ineligible — use paid line amount only.
    const discount = Math.max(0, Number(item.discount ?? 0));
    const gross = Math.max(
      0,
      Number(item.qty ?? 0) * Number(item.unitPrice ?? 0),
    );
    const base = roundMoney(Math.max(0, gross - discount));
    const cspsailorAmount = roundMoney((base * sailorShare) / 100);
    // Remainder ensures sailor + platform always equals line base
    const cspPlatformAmount = roundMoney(Math.max(0, base - cspsailorAmount));

    return {
      ...item,
      productName: lineName,
      productId: product._id,
      isCsp: true,
      cspEnrollmentId: enrollment._id,
      cspCustomerId: enrollment.customerId || product.cspCustomerId || null,
      discount,
      lineTotal: base,
      cspsailorAmount,
      cspPlatformAmount,
      _cspSailorSharePercent: sailorShare,
      _cspPlatformSharePercent: platformShare,
    };
  });
};

/** Ensure CSP owner wallet has the CspSale credit for this invoice (idempotent). */
const ensureCspsailorWalletCredits = async ({
  invoice,
  byCustomer,
  createdBy,
}) => {
  const ref = String(invoice?.invoiceCode || '').trim();
  const sailorCredits = [];

  for (const group of byCustomer.values()) {
    const sailor = await Customer.findById(group.customerId);
    if (!sailor) continue;

    let wallet = await Wallet.findOne({customerId: sailor._id});
    if (!wallet) {
      wallet = await Wallet.create({
        customerId: sailor._id,
        customerName: String(sailor.name ?? '').trim(),
        customerPhone: String(sailor.mobile ?? '').trim(),
        walletAmount: 0,
        affiliateBalance: 0,
        transactions: [],
      });
    }

    const alreadyForInvoice = (wallet.transactions || []).some(tx =>
      isCspSaleCredit(tx, ref),
    );

    if (!alreadyForInvoice && Number(group.amount) > 0) {
      await appendTransaction(wallet, {
        type: 'credit',
        amount: group.amount,
        note: buildCspEarningNote({
          invoice,
          productNames: group.productNames,
        }),
        referenceType: 'CspSale',
        referenceId: ref,
        walletType: 'withdrawable',
        createdBy,
      });
    }

    sailorCredits.push({
      customerId: group.customerId,
      amount: group.amount,
    });
  }

  return sailorCredits;
};

const groupSailorCreditsByCustomer = lines => {
  const byCustomer = new Map();
  for (const line of lines) {
    if (!line.cspCustomerId || Number(line.sailorAmount) <= 0) continue;
    const key = String(line.cspCustomerId);
    const prev = byCustomer.get(key) || {
      customerId: line.cspCustomerId,
      amount: 0,
      saleAmount: 0,
      productNames: [],
    };
    prev.amount = roundMoney(prev.amount + Number(line.sailorAmount));
    prev.saleAmount = roundMoney(
      prev.saleAmount + Number(line.lineBaseAmount || 0),
    );
    prev.productNames.push(line.productName || 'item');
    byCustomer.set(key, prev);
  }
  return byCustomer;
};

/** WhatsApp `cspsaleupdate` to each CSP owner; failures are logged, never thrown. */
const notifyCspOwnersOfSale = async ({invoice, byCustomer}) => {
  const invoiceLabel = formatInvoiceLabel(invoice);

  for (const group of byCustomer.values()) {
    try {
      const owner = await Customer.findById(group.customerId)
        .select('name mobile whatsappNumber')
        .lean();
      const to = String(owner?.whatsappNumber || owner?.mobile || '').trim();
      if (!to) {
        console.warn(
          `[CspSaleUpdate] skipped invoice=${invoice?.invoiceCode} owner=${group.customerId}: no mobile`,
        );
        continue;
      }

      const wallet = await Wallet.findOne({customerId: owner._id})
        .select('walletAmount')
        .lean();

      const result = await sendCspSaleUpdateWhatsApp({
        to,
        ownerName: owner.name,
        productNames: group.productNames,
        earningAmount: group.amount,
        saleAmount: group.saleAmount,
        invoiceLabel,
        walletBalance: Number(wallet?.walletAmount || 0),
      });
      if (!result?.delivered && result?.channel !== 'whatsapp-stub') {
        console.warn(
          `[CspSaleUpdate] not delivered invoice=${invoice?.invoiceCode} owner=${group.customerId}: ${result?.error || 'unknown error'}`,
        );
      }
    } catch (err) {
      console.error(
        `[CspSaleUpdate] failed invoice=${invoice?.invoiceCode} owner=${group.customerId}:`,
        err?.message || err,
      );
    }
  }
};

const buildSettlementLines = cspItems =>
  cspItems.map(item => {
    const base = roundMoney(
      Number(item.lineTotal) ||
        Math.max(
          0,
          Number(item.qty || 0) * Number(item.unitPrice || 0) -
            Number(item.discount || 0),
        ),
    );
    const sailorAmount = roundMoney(Number(item.cspsailorAmount) || 0);
    const platformAmount = roundMoney(
      Number(item.cspPlatformAmount) || Math.max(0, base - sailorAmount),
    );
    return {
      productName: String(item.productName || ''),
      productId: item.productId || null,
      cspEnrollmentId: item.cspEnrollmentId || null,
      cspCustomerId: item.cspCustomerId || null,
      lineBaseAmount: base,
      sailorSharePercent: Number(
        item._cspSailorSharePercent ?? getCspsailorSharePercent(),
      ),
      platformSharePercent: Number(
        item._cspPlatformSharePercent ?? getCspPlatformSharePercent(),
      ),
      sailorAmount,
      platformAmount,
    };
  });

/**
 * After successful (full) payment for CSP products:
 * - Credit 70% to CSP owner wallet
 * - Persist 30% in CspSettlement (never walleted)
 * Idempotent via unique invoiceCode + wallet CspSale reference checks.
 */
export const settleCspPaymentSplit = async ({
  invoice,
  items,
  createdBy,
  notifyOwners = true,
}) => {
  const ref = String(invoice?.invoiceCode || '').trim();
  const invoiceId = invoice?._id;
  if (!ref || !invoiceId) return null;

  if (!isInvoicePaymentComplete(invoice)) {
    return null;
  }

  const sourceItems = Array.isArray(items) ? items : invoice.items || [];
  const cspItems = sourceItems.filter(
    i =>
      i?.isCsp &&
      i.cspCustomerId &&
      (Number(i.cspsailorAmount) > 0 || Number(i.cspPlatformAmount) > 0),
  );

  const existing = await CspSettlement.findOne({invoiceCode: ref});
  if (existing) {
    // Repair path: settlement exists but wallet credit may have been missed
    if (existing.status === 'settled') {
      const repairGroups = new Map();
      for (const credit of existing.sailorCredits || []) {
        if (!credit?.customerId || Number(credit.amount) <= 0) continue;
        repairGroups.set(String(credit.customerId), {
          customerId: credit.customerId,
          amount: roundMoney(Number(credit.amount)),
          productNames: (existing.lines || []).map(l => l.productName),
        });
      }
      if (repairGroups.size) {
        await ensureCspsailorWalletCredits({
          invoice,
          byCustomer: repairGroups,
          createdBy,
        });
      }
      if (!invoice.cspSettledAt) {
        await Invoice.updateOne(
          {_id: invoiceId},
          {
            $set: {
              cspSailorTotal: Number(existing.sailorTotal || 0),
              cspPlatformTotal: Number(existing.platformTotal || 0),
              cspSettledAt: existing.settledAt || new Date(),
            },
          },
        );
      }
    }
    return existing;
  }

  if (invoice.cspSettledAt && !cspItems.length) {
    return null;
  }

  if (!cspItems.length) return null;

  const lines = buildSettlementLines(cspItems);
  const sailorTotal = roundMoney(
    lines.reduce((s, l) => s + Number(l.sailorAmount || 0), 0),
  );
  const platformTotal = roundMoney(
    lines.reduce((s, l) => s + Number(l.platformAmount || 0), 0),
  );
  const byCustomer = groupSailorCreditsByCustomer(lines);

  // Claim settlement first (unique invoiceCode) so concurrent retries cannot double-credit
  let settlement;
  try {
    settlement = await CspSettlement.create({
      invoiceId,
      invoiceCode: ref,
      sailorTotal,
      platformTotal,
      lines,
      sailorCredits: [...byCustomer.values()].map(g => ({
        customerId: g.customerId,
        amount: g.amount,
      })),
      status: 'settled',
      settledAt: new Date(),
      createdBy: createdBy || {},
    });
  } catch (err) {
    if (err?.code === 11000) {
      return settleCspPaymentSplit({invoice, items, createdBy});
    }
    throw err;
  }

  await ensureCspsailorWalletCredits({
    invoice,
    byCustomer,
    createdBy,
  });

  await Invoice.updateOne(
    {_id: invoiceId},
    {
      $set: {
        cspSailorTotal: sailorTotal,
        cspPlatformTotal: platformTotal,
        cspSettledAt: settlement.settledAt,
      },
    },
  );

  if (notifyOwners) {
    notifyCspOwnersOfSale({invoice, byCustomer}).catch(err =>
      console.error('[CspSaleUpdate] notify failed:', err?.message || err),
    );
  }

  return settlement;
};

/**
 * Re-enrich invoice lines from catalogue and settle any missed CSP credits.
 * Safe to run repeatedly — unique invoiceCode + CspSale referenceId prevent duplicates.
 */
export const backfillMissedCspSettlements = async ({
  createdBy = {
    m_staff_id: 'system',
    m_staff_name: 'CSP Backfill',
    m_staff_email: null,
  },
  invoiceCodes = null,
  dryRun = false,
} = {}) => {
  const query = {
    status: {$nin: ['draft', 'cancelled']},
  };
  if (Array.isArray(invoiceCodes) && invoiceCodes.length) {
    query.invoiceCode = {$in: invoiceCodes.map(c => String(c).trim())};
  }

  const invoices = await Invoice.find(query).sort({invoiceNumber: 1});
  const results = {
    scanned: 0,
    eligible: 0,
    settled: 0,
    skipped: 0,
    dryRun,
    details: [],
  };

  for (const invoice of invoices) {
    results.scanned += 1;
    if (!isInvoicePaymentComplete(invoice)) {
      results.skipped += 1;
      continue;
    }

    const existing = await CspSettlement.findOne({
      invoiceCode: invoice.invoiceCode,
    }).lean();
    if (existing?.status === 'settled') {
      // Still repair wallet if needed
      if (!dryRun) {
        await settleCspPaymentSplit({
          invoice,
          items: invoice.items,
          createdBy,
        });
      }
      results.skipped += 1;
      continue;
    }

    const enrichedItems = await enrichItemsWithCsp(invoice.items || []);
    const cspItems = enrichedItems.filter(i => i?.isCsp && i.cspCustomerId);
    if (!cspItems.length) {
      results.skipped += 1;
      continue;
    }

    const sailorTotal = roundMoney(
      cspItems.reduce((s, i) => s + Number(i.cspsailorAmount || 0), 0),
    );
    const platformTotal = roundMoney(
      cspItems.reduce((s, i) => s + Number(i.cspPlatformAmount || 0), 0),
    );

    results.eligible += 1;
    results.details.push({
      invoiceCode: invoice.invoiceCode,
      invoiceNumber: invoice.invoiceNumber,
      sailorTotal,
      platformTotal,
      owners: [
        ...new Set(cspItems.map(i => String(i.cspCustomerId))),
      ],
    });

    if (dryRun) continue;

    invoice.items = enrichedItems;
    await invoice.save();

    await settleCspPaymentSplit({
      invoice,
      items: enrichedItems,
      createdBy,
      notifyOwners: false,
    });
    results.settled += 1;
  }

  return results;
};

/** Reverse CSP sailor wallet credits + mark platform retention reversed. */
export const reverseCspPaymentSplit = async ({invoice, createdBy}) => {
  const ref = String(invoice?.invoiceCode || '').trim();
  if (!ref || !Array.isArray(invoice?.items)) return;

  const cspItems = invoice.items.filter(
    i => i?.isCsp && Number(i.cspsailorAmount) > 0 && i.cspCustomerId,
  );

  if (cspItems.length) {
    const byCustomer = new Map();
    for (const item of cspItems) {
      const key = String(item.cspCustomerId);
      const prev = byCustomer.get(key) || {
        customerId: item.cspCustomerId,
        amount: 0,
      };
      prev.amount = roundMoney(prev.amount + Number(item.cspsailorAmount));
      byCustomer.set(key, prev);
    }

    for (const group of byCustomer.values()) {
      const sailor = await Customer.findById(group.customerId);
      if (!sailor) continue;

      const wallet = await Wallet.findOne({customerId: sailor._id});
      if (!wallet) continue;

      const alreadyReversed = (wallet.transactions || []).some(
        tx =>
          String(tx.referenceId || '').trim() === ref &&
          String(tx.type || '').toLowerCase() === 'debit' &&
          String(tx.referenceType || '') === 'CspSale',
      );
      if (alreadyReversed) continue;

      const hasCredit = (wallet.transactions || []).some(
        tx =>
          String(tx.referenceId || '').trim() === ref &&
          String(tx.type || '').toLowerCase() === 'credit' &&
          String(tx.referenceType || '') === 'CspSale',
      );
      if (!hasCredit) continue;

      await appendTransaction(wallet, {
        type: 'debit',
        amount: group.amount,
        note: `CSP Product Earning reversed · Invoice ${ref}`,
        referenceType: 'CspSale',
        referenceId: ref,
        walletType: 'withdrawable',
        createdBy,
      });
    }
  }

  await CspSettlement.updateOne(
    {invoiceCode: ref, status: 'settled'},
    {$set: {status: 'reversed', reversedAt: new Date()}},
  );

  if (invoice._id) {
    await Invoice.updateOne(
      {_id: invoice._id},
      {$set: {cspSettledAt: null}},
    );
  }
};

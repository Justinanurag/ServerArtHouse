import mongoose from "mongoose";
import Purchase from "../models/purchase.model.js";
import Invoice from "../models/invoice.model.js";
import ReturnSale from "../models/returnSale.model.js";
import PurchaseReturn from "../models/purchaseReturn.model.js";

const normalizeName = (value) => String(value ?? "").trim();
const nameKey = (value) => normalizeName(value).toLowerCase();

const escapeRegex = (value) =>
  String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const safeQty = (value) => {
  const qty = Number(value);
  return Number.isFinite(qty) ? qty : 0;
};

const addQty = (stockMap, name, delta) => {
  const key = nameKey(name);
  if (!key) return;
  const current = stockMap.get(key) ?? 0;
  stockMap.set(key, current + delta);
};

/**
 * Catalogue / purchase / invoice lines for variants use "Parent - Variant".
 * Collect every stock key that can receive movements for a product doc.
 */
export const getProductStockNames = (product) => {
  const parentName = normalizeName(product?.productName);
  if (!parentName) return [];

  const names = [parentName];
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  for (const variant of variants) {
    const variantName = normalizeName(variant?.name);
    if (!variantName) continue;
    names.push(`${parentName} - ${variantName}`);
  }
  return names;
};

export const getStockQtyForName = (stockMap, name) => {
  if (!stockMap) return 0;
  const key = nameKey(name);
  if (!key) return 0;
  if (stockMap.has(key)) return Number(stockMap.get(key) ?? 0);
  // Also support maps keyed by original display names
  if (stockMap.has(normalizeName(name))) {
    return Number(stockMap.get(normalizeName(name)) ?? 0);
  }
  return 0;
};

/** Stock shown to clients never goes below zero. */
export const nonNegativeQty = (value) => Math.max(0, safeQty(value));

export const sumStockForNames = (stockMap, names = []) =>
  nonNegativeQty(
    names.reduce((sum, name) => sum + getStockQtyForName(stockMap, name), 0),
  );

export const availableStockForName = (stockMap, name) =>
  nonNegativeQty(getStockQtyForName(stockMap, name));

const countsTowardStock = (status) =>
  String(status ?? "").trim().toLowerCase() !== "cancelled";

const movementDocsQuery = (names) => {
  const base = {
    status: { $nin: ["cancelled", "Cancelled", "canceled", "Canceled"] },
  };
  if (!Array.isArray(names) || names.length === 0) return base;

  // Case-insensitive match so purchase "Shirt - Red" maps to catalogue "Shirt - Red"
  return {
    ...base,
    $or: names.map((n) => ({
      "items.productName": {
        $regex: `^${escapeRegex(normalizeName(n))}$`,
        $options: "i",
      },
    })),
  };
};

/**
 * Purchases add stock. Purchase returns remove it.
 * A sale removes only the quantity still sold (qty − already returned).
 * Cancelling or deleting the invoice drops that deduction, which puts the
 * quantity back. A return document is not added again when the invoice
 * already records returnedQty, and it is ignored once that invoice is
 * cancelled or deleted.
 */
export const foldStockDocuments = ({
  purchases = [],
  invoices = [],
  returnSales = [],
  purchaseReturns = [],
  includeName = () => true,
} = {}) => {
  const qtyByKey = new Map();
  const invoiceById = new Map();

  for (const invoice of invoices) {
    if (invoice?._id) invoiceById.set(String(invoice._id), invoice);
  }

  for (const purchase of purchases) {
    if (!countsTowardStock(purchase?.status)) continue;
    for (const item of purchase?.items ?? []) {
      const name = normalizeName(item?.productName);
      if (!includeName(name)) continue;
      addQty(qtyByKey, name, safeQty(item?.qty));
    }
  }

  for (const purchaseReturn of purchaseReturns) {
    if (!countsTowardStock(purchaseReturn?.status)) continue;
    for (const item of purchaseReturn?.items ?? []) {
      const name = normalizeName(item?.productName);
      if (!includeName(name)) continue;
      addQty(qtyByKey, name, -safeQty(item?.qty));
    }
  }

  const linkedReturnQty = new Map();
  for (const saleReturn of returnSales) {
    if (!countsTowardStock(saleReturn?.status)) continue;
    const invoiceId = saleReturn?.originalInvoiceId
      ? String(saleReturn.originalInvoiceId)
      : "";
    if (invoiceId) {
      const invoice = invoiceById.get(invoiceId);
      // Cancelled or deleted invoice already restored this quantity.
      if (!invoice || !countsTowardStock(invoice.status)) continue;
      for (const item of saleReturn?.items ?? []) {
        const name = normalizeName(item?.productName);
        if (!includeName(name)) continue;
        const key = `${invoiceId}\0${nameKey(name)}`;
        linkedReturnQty.set(
          key,
          (linkedReturnQty.get(key) ?? 0) + safeQty(item?.qty),
        );
      }
      continue;
    }
    for (const item of saleReturn?.items ?? []) {
      const name = normalizeName(item?.productName);
      if (!includeName(name)) continue;
      addQty(qtyByKey, name, safeQty(item?.qty));
    }
  }

  const usedReturnKeys = new Set();
  for (const invoice of invoices) {
    if (!countsTowardStock(invoice?.status)) continue;
    const invoiceId = String(invoice._id ?? "");
    const byName = new Map();
    for (const item of invoice?.items ?? []) {
      const name = normalizeName(item?.productName);
      if (!name || !includeName(name)) continue;
      const key = nameKey(name);
      const bucket = byName.get(key) ?? { name, qty: 0, returned: 0 };
      bucket.qty += safeQty(item?.qty);
      bucket.returned += safeQty(item?.returnedQty);
      byName.set(key, bucket);
    }
    for (const [key, bucket] of byName) {
      const linkKey = `${invoiceId}\0${key}`;
      const linked = linkedReturnQty.get(linkKey) ?? 0;
      if (linkedReturnQty.has(linkKey)) usedReturnKeys.add(linkKey);
      const restored = Math.max(bucket.returned, linked);
      const stillSold = Math.max(0, bucket.qty - restored);
      addQty(qtyByKey, bucket.name, -stillSold);
    }
  }

  for (const [key, qty] of linkedReturnQty) {
    if (usedReturnKeys.has(key) || qty <= 0) continue;
    const returnedName = key.split("\0")[1];
    if (!returnedName) continue;
    addQty(qtyByKey, returnedName, qty);
  }

  return qtyByKey;
};

/**
 * Live stock by product line name:
 * purchases (+) − invoices (−) + sales returns (+) − purchase returns (−)
 *
 * Returns a Map keyed by lowercase name (and also original requested names).
 */
export const computeStockByProductNames = async ({
  names = [],
  excludeInvoiceId = null,
} = {}) => {
  const normalizedNames = [
    ...new Set(names.map(normalizeName).filter(Boolean)),
  ];
  const query = movementDocsQuery(normalizedNames);

  const invoiceQuery = { ...query };
  if (excludeInvoiceId && mongoose.Types.ObjectId.isValid(excludeInvoiceId)) {
    invoiceQuery._id = { $ne: new mongoose.Types.ObjectId(excludeInvoiceId) };
  }

  const [purchases, invoices, returnSales, purchaseReturns] = await Promise.all([
    Purchase.find(query, { items: 1, status: 1 }).lean(),
    Invoice.find(invoiceQuery, { items: 1, status: 1 }).lean(),
    ReturnSale.find(query, { items: 1, status: 1, originalInvoiceId: 1 }).lean(),
    PurchaseReturn.find(query, { items: 1, status: 1 }).lean(),
  ]);

  const requestedKeys = new Set(normalizedNames.map(nameKey));
  const shouldInclude = (name) => {
    if (!requestedKeys.size) return Boolean(nameKey(name));
    return requestedKeys.has(nameKey(name));
  };

  const qtyByKey = foldStockDocuments({
    purchases,
    invoices,
    returnSales,
    purchaseReturns,
    includeName: shouldInclude,
  });

  // Expose both lowercase keys and original requested display names for callers
  const stockMap = new Map(qtyByKey);
  for (const name of normalizedNames) {
    stockMap.set(name, qtyByKey.get(nameKey(name)) ?? 0);
  }

  return stockMap;
};

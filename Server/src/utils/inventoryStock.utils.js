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

export const sumStockForNames = (stockMap, names = []) =>
  names.reduce((sum, name) => sum + getStockQtyForName(stockMap, name), 0);

const movementDocsQuery = (names) => {
  const base = { status: { $ne: "cancelled" } };
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
    Purchase.find(query, { items: 1 }).lean(),
    Invoice.find(invoiceQuery, { items: 1 }).lean(),
    ReturnSale.find(query, { items: 1 }).lean(),
    PurchaseReturn.find(query, { items: 1 }).lean(),
  ]);

  const qtyByKey = new Map();
  const requestedKeys = new Set(normalizedNames.map(nameKey));

  const shouldInclude = (name) => {
    if (!requestedKeys.size) return Boolean(nameKey(name));
    return requestedKeys.has(nameKey(name));
  };

  for (const doc of purchases) {
    for (const item of doc?.items ?? []) {
      const name = normalizeName(item?.productName);
      if (!shouldInclude(name)) continue;
      addQty(qtyByKey, name, safeQty(item?.qty));
    }
  }

  for (const doc of invoices) {
    for (const item of doc?.items ?? []) {
      const name = normalizeName(item?.productName);
      if (!shouldInclude(name)) continue;
      addQty(qtyByKey, name, -safeQty(item?.qty));
    }
  }

  for (const doc of returnSales) {
    for (const item of doc?.items ?? []) {
      const name = normalizeName(item?.productName);
      if (!shouldInclude(name)) continue;
      addQty(qtyByKey, name, safeQty(item?.qty));
    }
  }

  for (const doc of purchaseReturns) {
    for (const item of doc?.items ?? []) {
      const name = normalizeName(item?.productName);
      if (!shouldInclude(name)) continue;
      addQty(qtyByKey, name, -safeQty(item?.qty));
    }
  }

  // Expose both lowercase keys and original requested display names for callers
  const stockMap = new Map(qtyByKey);
  for (const name of normalizedNames) {
    stockMap.set(name, qtyByKey.get(nameKey(name)) ?? 0);
  }

  return stockMap;
};

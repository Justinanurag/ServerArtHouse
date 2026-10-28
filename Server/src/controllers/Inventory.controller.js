import Purchase from "../models/purchase.model.js";
import Invoice from "../models/invoice.model.js";
import ReturnSale from "../models/returnSale.model.js";
import PurchaseReturn from "../models/purchaseReturn.model.js";

const toNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

const normalizeProductName = (value) => String(value ?? "").trim();

const includeByStatus = (status) => String(status ?? "").toLowerCase() !== "cancelled";

const bumpMovement = (map, item, movementType, docCreatedAt) => {
  const name = normalizeProductName(item?.productName);
  if (!name) return;

  const qty = toNumber(item?.qty);
  const unitPrice = toNumber(item?.unitPrice);
  if (qty <= 0) return;

  const current = map.get(name) ?? {
    item: name,
    qty: 0,
    purchase_price: 0,
    sale_price: 0,
    last_updated: null,
  };

  if (movementType === "purchase") current.qty += qty;
  if (movementType === "invoice") current.qty -= qty;
  if (movementType === "sales_return") current.qty += qty;
  if (movementType === "purchase_return") current.qty -= qty;

  if (movementType === "purchase" || movementType === "purchase_return") {
    current.purchase_price = unitPrice;
  }

  if (movementType === "invoice" || movementType === "sales_return") {
    current.sale_price = unitPrice;
  }

  const candidateDate = docCreatedAt ? new Date(docCreatedAt) : null;
  if (
    candidateDate &&
    !Number.isNaN(candidateDate.getTime()) &&
    (!current.last_updated || candidateDate > new Date(current.last_updated))
  ) {
    current.last_updated = candidateDate.toISOString();
  }

  map.set(name, current);
};

export const getInventories = async (req, res) => {
  try {
    const [purchases, invoices, returnSales, purchaseReturns] = await Promise.all([
      Purchase.find(
        { status: { $ne: "cancelled" } },
        { items: 1, createdAt: 1, status: 1 },
      ).lean(),
      Invoice.find(
        { status: { $ne: "cancelled" } },
        { items: 1, createdAt: 1, status: 1 },
      ).lean(),
      ReturnSale.find(
        { status: { $ne: "cancelled" } },
        { items: 1, createdAt: 1, status: 1 },
      ).lean(),
      PurchaseReturn.find(
        { status: { $ne: "cancelled" } },
        { items: 1, createdAt: 1, status: 1 },
      ).lean(),
    ]);

    const stockMap = new Map();

    for (const purchase of purchases) {
      if (!includeByStatus(purchase?.status)) continue;
      for (const item of purchase?.items ?? []) {
        bumpMovement(stockMap, item, "purchase", purchase?.createdAt);
      }
    }

    for (const invoice of invoices) {
      if (!includeByStatus(invoice?.status)) continue;
      for (const item of invoice?.items ?? []) {
        bumpMovement(stockMap, item, "invoice", invoice?.createdAt);
      }
    }

    for (const returnSale of returnSales) {
      if (!includeByStatus(returnSale?.status)) continue;
      for (const item of returnSale?.items ?? []) {
        bumpMovement(stockMap, item, "sales_return", returnSale?.createdAt);
      }
    }

    for (const purchaseReturn of purchaseReturns) {
      if (!includeByStatus(purchaseReturn?.status)) continue;
      for (const item of purchaseReturn?.items ?? []) {
        bumpMovement(stockMap, item, "purchase_return", purchaseReturn?.createdAt);
      }
    }

    const inventories = Array.from(stockMap.values())
      .map((entry, index) => ({
        id: index + 1,
        item: entry.item,
        qty: toNumber(entry.qty),
        purchase_price: `₹ ${toNumber(entry.purchase_price).toFixed(2)}`,
        sale_price: `₹ ${toNumber(entry.sale_price).toFixed(2)}`,
        last_updated: entry.last_updated
          ? new Date(entry.last_updated).toLocaleString("en-IN")
          : "-",
      }))
      .sort((a, b) => a.item.localeCompare(b.item));

    const lowStockItems = inventories.filter((item) => item.qty <= 0);
    const positiveStockItems = inventories.filter((item) => item.qty > 0);

    const lowStockQty = lowStockItems.reduce((sum, item) => sum + toNumber(item.qty), 0);
    const positiveStockQty = positiveStockItems.reduce(
      (sum, item) => sum + toNumber(item.qty),
      0,
    );

    const stockValueSalesPrice = inventories.reduce((sum, item) => {
      const salePrice = toNumber(String(item.sale_price).replace(/[^\d.-]/g, ""));
      return sum + salePrice * toNumber(item.qty);
    }, 0);

    const stockValuePurchasePrice = inventories.reduce((sum, item) => {
      const purchasePrice = toNumber(String(item.purchase_price).replace(/[^\d.-]/g, ""));
      return sum + purchasePrice * toNumber(item.qty);
    }, 0);

    return res.status(200).json({
      success: true,
      message: "Inventory fetched successfully.",
      inventories,
      summary: {
        lowStock: {
          items: lowStockItems.length,
          qty: lowStockQty,
        },
        positiveStock: {
          items: positiveStockItems.length,
          qty: positiveStockQty,
        },
        stockValueSalesPrice,
        stockValuePurchasePrice,
      },
    });
  } catch (error) {
    console.error("getInventories error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch inventory.",
    });
  }
};

export const createInventory = async (req, res) =>
  res.status(405).json({ success: false, message: "Method not allowed." });

export const getInventoryById = async (req, res) =>
  res.status(405).json({ success: false, message: "Method not allowed." });

export const updateInventory = async (req, res) =>
  res.status(405).json({ success: false, message: "Method not allowed." });

export const deleteInventory = async (req, res) =>
  res.status(405).json({ success: false, message: "Method not allowed." });

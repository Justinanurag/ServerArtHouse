import Purchase from "../models/purchase.model.js";
import Invoice from "../models/invoice.model.js";
import ReturnSale from "../models/returnSale.model.js";
import PurchaseReturn from "../models/purchaseReturn.model.js";
import Food from "../models/food.model.js";
import Product from "../models/product.model.js";
import {
  computeStockByProductNames,
  getProductStockNames,
  getStockQtyForName,
  getManagedFoodSaleCutoff,
} from "../utils/inventoryStock.utils.js";

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
    const [purchases, invoices, returnSales, purchaseReturns, cutoff, managedFoods] =
      await Promise.all([
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
      getManagedFoodSaleCutoff(),
      Food.find({ manageInventory: true }).select("name price updatedAt").lean(),
    ]);

    const stockMap = new Map();

    for (const purchase of purchases) {
      if (!includeByStatus(purchase?.status)) continue;
      for (const item of purchase?.items ?? []) {
        bumpMovement(stockMap, item, "purchase", purchase?.createdAt);
      }
    }

    const saleCounts = (name, createdAt) => {
      const since = cutoff.get(String(name || "").trim().toLowerCase());
      if (!since) return true;
      const when = createdAt ? new Date(createdAt) : null;
      if (!when || Number.isNaN(when.getTime())) return true;
      return when >= since;
    };

    for (const invoice of invoices) {
      if (!includeByStatus(invoice?.status)) continue;
      for (const item of invoice?.items ?? []) {
        if (!saleCounts(item?.productName, invoice?.createdAt)) continue;
        bumpMovement(stockMap, item, "invoice", invoice?.createdAt);
      }
    }

    for (const returnSale of returnSales) {
      if (!includeByStatus(returnSale?.status)) continue;
      for (const item of returnSale?.items ?? []) {
        if (!saleCounts(item?.productName, returnSale?.createdAt)) continue;
        bumpMovement(stockMap, item, "sales_return", returnSale?.createdAt);
      }
    }

    for (const purchaseReturn of purchaseReturns) {
      if (!includeByStatus(purchaseReturn?.status)) continue;
      for (const item of purchaseReturn?.items ?? []) {
        bumpMovement(stockMap, item, "purchase_return", purchaseReturn?.createdAt);
      }
    }

    const knownNames = new Set(
      Array.from(stockMap.keys()).map((name) => String(name).trim().toLowerCase()),
    );
    for (const food of managedFoods) {
      const name = String(food?.name || "").trim();
      if (!name || knownNames.has(name.toLowerCase())) continue;
      stockMap.set(name, {
        item: name,
        qty: 0,
        purchase_price: 0,
        sale_price: toNumber(food?.price),
        last_updated: food?.updatedAt
          ? new Date(food.updatedAt).toISOString()
          : null,
      });
    }

    const alertProducts = await Product.find({
      lowStockAlertLevel: {$ne: null},
      itemType: {$ne: "service"},
      type: {$ne: "service"},
    })
      .select("productName lowStockAlertLevel variants.name")
      .lean();
    const thresholds = new Map();
    for (const product of alertProducts) {
      const level = Number(product.lowStockAlertLevel);
      if (!Number.isFinite(level) || level < 0) continue;
      const parent = normalizeProductName(product.productName);
      if (parent) thresholds.set(parent.toLowerCase(), level);
      for (const variant of product.variants || []) {
        const variantName = normalizeProductName(variant?.name);
        if (!parent || !variantName) continue;
        thresholds.set(`${parent} - ${variantName}`.toLowerCase(), level);
      }
    }

    const inventories = Array.from(stockMap.values())
      .map((entry, index) => {
        const qty = toNumber(entry.qty);
        const level = thresholds.has(String(entry.item).trim().toLowerCase())
          ? thresholds.get(String(entry.item).trim().toLowerCase())
          : null;
        return {
          id: index + 1,
          item: entry.item,
          qty,
          purchase_price: `₹ ${toNumber(entry.purchase_price).toFixed(2)}`,
          sale_price: `₹ ${toNumber(entry.sale_price).toFixed(2)}`,
          last_updated: entry.last_updated
            ? new Date(entry.last_updated).toLocaleString("en-IN")
            : "-",
          lowStockAlertLevel: level,
          isLowStock: level != null && qty <= level,
        };
      })
      .sort((a, b) => a.item.localeCompare(b.item));

    const lowStockItems = inventories.filter((item) => item.isLowStock);
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

    const stockFilter = String(req.query.stock || "all").trim().toLowerCase();
    const visibleInventories =
      stockFilter === "low"
        ? inventories.filter((item) => item.isLowStock)
        : inventories;

    return res.status(200).json({
      success: true,
      message: "Inventory fetched successfully.",
      inventories: visibleInventories,
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

const escapeRegex = (value) =>
  String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const lowStockProductNames = async () => {
  const products = await Product.find({
    lowStockAlertLevel: {$ne: null},
    itemType: {$ne: "service"},
    type: {$ne: "service"},
  })
    .select("productName lowStockAlertLevel variants.name")
    .lean();
  if (!products.length) return [];
  const stock = await computeStockByProductNames();
  const names = [];
  for (const product of products) {
    const level = Number(product.lowStockAlertLevel);
    if (!Number.isFinite(level) || level < 0) continue;
    for (const name of getProductStockNames(product)) {
      if (getStockQtyForName(stock, name) <= level) names.push(name);
    }
  }
  return names;
};

const movementStages = ({
  type,
  numberExpr,
  entityExpr,
  actorExpr,
  categoryFallback,
  names,
  product,
  from,
  to,
  search,
}) => {
  const nameCriterion = (() => {
    if (product && names) {
      const wanted = names.filter(
        (name) => String(name).trim().toLowerCase() === product.toLowerCase(),
      );
      return {$in: wanted};
    }
    if (product) return {$regex: `^${escapeRegex(product)}$`, $options: "i"};
    if (names) return {$in: names};
    return null;
  })();
  const docMatch = {status: {$ne: "cancelled"}};
  if (from || to) {
    const range = {};
    if (from) range.$gte = from;
    if (to) range.$lte = to;
    docMatch.$or = [
      {invoiceDate: range},
      {invoiceDate: null, createdAt: range},
    ];
  }
  if (nameCriterion) docMatch["items.productName"] = nameCriterion;
  const stages = [
    {$match: docMatch},
    {$addFields: {movementDate: {$ifNull: ["$invoiceDate", "$createdAt"]}}},
    {$unwind: "$items"},
  ];
  if (nameCriterion) stages.push({$match: {"items.productName": nameCriterion}});
  stages.push({
    $project: {
      _id: 1,
      lineId: "$items._id",
      movementDate: 1,
      type: {$literal: type},
      productName: {$ifNull: ["$items.productName", "Unknown Product"]},
      qty: {$ifNull: ["$items.qty", 0]},
      amount: {$ifNull: ["$items.unitPrice", 0]},
      invoiceNo: numberExpr,
      createdBy: actorExpr,
      entityName: entityExpr,
      category: {$ifNull: ["$items.category", categoryFallback]},
    },
  });
  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i");
    stages.push({
      $match: {
        $or: [
          {productName: pattern},
          {invoiceNo: pattern},
          {entityName: pattern},
        ],
      },
    });
  }
  return stages;
};

export const getInventoryTimeline = async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
    const search = String(req.query.search || "").trim();
    const product = String(req.query.product || "").trim();
    const type = String(req.query.type || "ALL").trim().toUpperCase();
    const stock = String(req.query.stock || "all").trim().toLowerCase();
    const from = req.query.fromDate ? new Date(String(req.query.fromDate)) : null;
    const to = req.query.toDate ? new Date(String(req.query.toDate)) : null;
    if (to && !Number.isNaN(to.getTime())) to.setHours(23, 59, 59, 999);
    const fromDate = from && !Number.isNaN(from.getTime()) ? from : null;
    const toDate = to && !Number.isNaN(to.getTime()) ? to : null;

    let names = null;
    if (stock === "low") {
      names = await lowStockProductNames();
      if (!names.length) {
        return res.status(200).json({
          success: true,
          entries: [],
          page,
          limit,
          total: 0,
          totalPages: 1,
          summary: {totalIn: 0, totalOut: 0, valueIn: 0, valueOut: 0},
        });
      }
    }

    const shared = {names, product, from: fromDate, to: toDate, search};
    const invoiceStages = movementStages({
      ...shared,
      type: "OUT",
      numberExpr: {$ifNull: ["$invoiceCode", {$ifNull: ["$invoiceNumber", "N/A"]}]},
      entityExpr: {$ifNull: ["$customerName", "Walk-in Customer"]},
      actorExpr: {$ifNull: ["$createdBy.m_staff_name", "System"]},
      categoryFallback: "General",
    });
    const purchaseStages = movementStages({
      ...shared,
      type: "IN",
      numberExpr: {$ifNull: ["$invoiceNumber", "N/A"]},
      entityExpr: {$ifNull: ["$supplierName", "Direct Purchase"]},
      actorExpr: {$ifNull: ["$purchaser", "System"]},
      categoryFallback: "Purchase",
    });

    let pipeline;
    if (type === "OUT") pipeline = invoiceStages;
    else if (type === "IN") pipeline = purchaseStages;
    else {
      pipeline = [
        ...invoiceStages,
        {$unionWith: {coll: Purchase.collection.name, pipeline: purchaseStages}},
      ];
    }
    pipeline.push({
      $facet: {
        rows: [
          {$sort: {movementDate: -1, _id: -1}},
          {$skip: (page - 1) * limit},
          {$limit: limit},
        ],
        total: [{$count: "count"}],
        sums: [
          {
            $group: {
              _id: "$type",
              qty: {$sum: "$qty"},
              value: {$sum: {$multiply: [{$ifNull: ["$qty", 0]}, {$ifNull: ["$amount", 0]}]}},
            },
          },
        ],
      },
    });

    const source = type === "IN" ? Purchase : Invoice;
    const [result] = await source.aggregate(pipeline).allowDiskUse(true);
    const total = Number(result?.total?.[0]?.count || 0);
    const sums = Array.isArray(result?.sums) ? result.sums : [];
    const sumFor = (key) => sums.find((row) => row._id === key) || {qty: 0, value: 0};
    const stockIn = sumFor("IN");
    const stockOut = sumFor("OUT");

    return res.status(200).json({
      success: true,
      entries: (result?.rows || []).map((row) => ({
        id: `${row.type}-${row._id}-${row.lineId || row.productName}`,
        date: row.movementDate,
        type: row.type,
        productName: row.productName,
        qty: toNumber(row.qty),
        amount: toNumber(row.amount),
        invoiceNo: row.invoiceNo || "N/A",
        createdBy: row.createdBy || "System",
        entityName: row.entityName || "",
        category: row.category || "",
      })),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      summary: {
        totalIn: toNumber(stockIn.qty),
        totalOut: toNumber(stockOut.qty),
        valueIn: toNumber(stockIn.value),
        valueOut: toNumber(stockOut.value),
      },
    });
  } catch (error) {
    console.error("getInventoryTimeline error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to load inventory timeline.",
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

import Food from '../models/food.model.js';
import Product from '../models/product.model.js';
import Purchase from '../models/purchase.model.js';
import Invoice from '../models/invoice.model.js';
import ReturnSale from '../models/returnSale.model.js';
import PurchaseReturn from '../models/purchaseReturn.model.js';
import {
  computeStockByProductNames,
  getStockQtyForName,
} from '../utils/inventoryStock.utils.js';

const escapeRegex = value => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const INSUFFICIENT_STOCK =
  'Insufficient stock. Please create a purchase for this item before selling.';

export const insufficientFoodStockMessage = name =>
  name ? `${INSUFFICIENT_STOCK} (${name})` : INSUFFICIENT_STOCK;

const retargetStockName = async (oldName, newName) => {
  const from = String(oldName || '').trim();
  const to = String(newName || '').trim();
  if (!from || !to || from === to) return;
  const filter = {'items.productName': from};
  const update = {$set: {'items.$[line].productName': to}};
  const options = {arrayFilters: [{'line.productName': from}]};
  await Promise.all([
    Purchase.updateMany(filter, update, options),
    Invoice.updateMany(filter, update, options),
    ReturnSale.updateMany(filter, update, options),
    PurchaseReturn.updateMany(filter, update, options),
  ]);
};

const productFields = (food, existing) => ({
  productName: String(food.name || '').trim(),
  sellingPrice: Math.max(0, Number(food.price) || 0),
  purchasePrice: Math.max(0, Number(existing?.purchasePrice) || 0),
  category: String(food.category || 'Food').trim() || 'Food',
  primaryUnit: String(food.unit || 'Plate').trim() || 'Plate',
  description: String(food.description || '').trim(),
  imageUrl: food.imageUrl || null,
  type: 'product',
  itemType: 'product',
  foodId: food._id,
  foodInventoryActive: true,
  applyMembershipDiscount: food.applyMembershipDiscount !== false,
});

/**
 * Keep one product for an inventory-managed food.
 * Reuses a same-name product instead of creating a second one.
 */
export const syncFoodInventoryProduct = async food => {
  if (!food?._id) return null;

  if (!food.manageInventory) {
    await Product.updateMany(
      {foodId: food._id},
      {$set: {foodInventoryActive: false}},
    );
    return null;
  }

  const name = String(food.name || '').trim();
  let product = null;
  if (food.productId) product = await Product.findById(food.productId);
  if (!product) product = await Product.findOne({foodId: food._id});
  if (!product) {
    product = await Product.findOne({
      itemType: {$ne: 'service'},
      type: {$ne: 'service'},
      productName: new RegExp(`^${escapeRegex(name)}$`, 'i'),
    });
  }

  if (product && (product.itemType === 'service' || product.type === 'service')) {
    product = null;
  }

  if (product?.foodId && String(product.foodId) !== String(food._id)) {
    const error = new Error('A product with this name is already linked to another food item.');
    error.status = 409;
    throw error;
  }

  const previousName = String(product?.productName || '').trim();
  if (product) {
    await Product.updateOne({_id: product._id}, {$set: productFields(food, product)});
    product = await Product.findById(product._id);
  } else {
    product = await Product.create({
      ...productFields(food, null),
      stockQty: 0,
      stockStatus: 'out_of_stock',
    });
  }

  if (previousName && previousName !== name) {
    await retargetStockName(previousName, name);
  }

  if (String(food.productId || '') !== String(product._id)) {
    await Food.updateOne({_id: food._id}, {$set: {productId: product._id}});
    food.productId = product._id;
  }

  return product;
};

export const deactivateFoodInventoryProduct = async foodId => {
  if (!foodId) return;
  await Product.updateMany({foodId}, {$set: {foodInventoryActive: false}});
};

export const attachFoodStock = async foods => {
  const rows = Array.isArray(foods) ? foods : [];
  const names = rows
    .filter(food => food?.manageInventory)
    .map(food => String(food.name || '').trim())
    .filter(Boolean);
  const stockMap = names.length
    ? await computeStockByProductNames({names})
    : new Map();

  return rows.map(food => {
    const plain = food?.toObject ? food.toObject() : {...food};
    if (!plain.manageInventory) {
      plain.availableStock = null;
      return plain;
    }
    plain.availableStock = getStockQtyForName(stockMap, plain.name);
    return plain;
  });
};

export const managedFoodNameSet = async () => {
  const foods = await Food.find({manageInventory: true}).select('name').lean();
  return new Set(
    foods.map(food => String(food.name || '').trim().toLowerCase()).filter(Boolean),
  );
};

import fs from 'fs';
import mongoose from 'mongoose';
import Product from '../models/product.model.js';
import CustomersailorProgram from '../models/customerSellerProgram.model.js';
import {uploadOnCloudinary} from '../utils/cloudinary.js';
import {sendError, sendSuccess} from '../modules/customer/utils/response.js';
import {invalidateProductSearchCache} from '../config/productSearchCache.js';

const PRODUCT_CATEGORIES = [
  'Art Supplies',
  'Home Decor',
  'Fashion',
  'Handmade Crafts',
  'Pottery & Ceramics',
  'Jewellery & Accessories',
  'Stationery & Journals',
  'Paintings & Canvas',
  'Toys & Dolls',
  'Candles & Fragrances',
  'Gift Hampers',
  'Prints & Digital Art',
  'Clothing & Apparel',
  'Organic Goods',
];

const discardUpload = file => {
  if (!file?.path) return;
  try {
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
  } catch {
    // Temp file cleanup is best-effort.
  }
};

const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const toProductDto = product => {
  const discountValue = Number(product.discountValue) || 0;
  const hasOffer = discountValue > 0;
  return {
    id: String(product._id),
    name: product.productName || '',
    price: Number(product.sellingPrice) || 0,
    stock: Number(product.stockQty) || 0,
    category: product.category || '',
    image: product.imageUrl || product.images?.[0] || '',
    offerType: hasOffer
      ? product.discountType === 'percentage'
        ? 'percent'
        : 'flat'
      : undefined,
    offerValue: hasOffer ? discountValue : undefined,
  };
};

const readFields = body => {
  const name = String(body?.name || body?.productName || '').trim();
  const category = String(body?.category || '').trim();
  const price = Number(body?.price ?? body?.sellingPrice);
  const stock = Math.trunc(Number(body?.stock ?? body?.stockQty));
  const offerType =
    String(body?.offerType || '').trim().toLowerCase() === 'flat'
      ? 'flat'
      : 'percent';
  const offerRaw = String(body?.offerValue ?? '').trim();

  if (!name) return {error: 'Product name is required.'};
  if (!PRODUCT_CATEGORIES.includes(category)) {
    return {error: 'Select a category.'};
  }
  if (!Number.isFinite(price) || price <= 0) {
    return {error: 'Price must be greater than 0.'};
  }
  if (!Number.isFinite(stock) || stock < 0) {
    return {error: 'Stock must be 0 or more.'};
  }

  let discountType = 'flat';
  let discountValue = 0;
  if (offerRaw) {
    const offerValue = Number(offerRaw);
    if (!Number.isFinite(offerValue) || offerValue <= 0) {
      return {error: 'Enter an offer greater than 0.'};
    }
    if (offerType === 'percent') {
      if (offerValue > 100) {
        return {error: 'Percent offer cannot be more than 100.'};
      }
      discountType = 'percentage';
      discountValue = offerValue;
    } else {
      if (offerValue >= price) {
        return {error: 'Flat offer must be less than the price.'};
      }
      discountType = 'flat';
      discountValue = offerValue;
    }
  }

  return {
    value: {
      name,
      category,
      price,
      stock,
      discountType,
      discountValue,
    },
  };
};

const activeEnrollment = customerId =>
  CustomersailorProgram.findOne({
    customerId,
    status: 'active',
  });

const storeImage = async file => {
  if (!file) return '';
  if (file.size > 2 * 1024 * 1024) {
    discardUpload(file);
    const error = new Error('Image must be 2 MB or smaller.');
    error.status = 400;
    throw error;
  }
  const uploaded = await uploadOnCloudinary(file.path, {
    folder: 'woowoo/csp-products',
  });
  if (uploaded) return uploaded;
  if (file.filename) return `/uploads/products/${file.filename}`;
  const error = new Error('Could not store the product image.');
  error.status = 502;
  throw error;
};

export const listMyCspProducts = async (req, res) => {
  try {
    const customerId = req.customer?._id;
    const enrollment = await activeEnrollment(customerId);
    if (!enrollment) {
      return sendSuccess(res, {
        message: 'No CSP products yet.',
        data: [],
      });
    }

    const products = await Product.find({
      isCsp: true,
      cspEnrollmentId: enrollment._id,
    })
      .sort({createdAt: -1})
      .lean();

    return sendSuccess(res, {
      message: 'CSP products fetched.',
      data: products.map(toProductDto),
    });
  } catch (error) {
    console.error('listMyCspProducts error:', error);
    return sendError(res, {
      status: 500,
      message: 'Failed to load products.',
    });
  }
};

export const createMyCspProduct = async (req, res) => {
  try {
    const customerId = req.customer?._id;
    const enrollment = await activeEnrollment(customerId);
    if (!enrollment) {
      discardUpload(req.file);
      return sendError(res, {
        status: 403,
        message: 'An approved CSP enrollment is required before adding products.',
      });
    }

    const parsed = readFields(req.body);
    if (parsed.error) {
      discardUpload(req.file);
      return sendError(res, {status: 400, message: parsed.error});
    }
    if (!req.file) {
      return sendError(res, {
        status: 400,
        message: 'Please upload a product image.',
      });
    }

    const {name, category, price, stock, discountType, discountValue} =
      parsed.value;
    const duplicate = await Product.findOne({
      isCsp: true,
      cspEnrollmentId: enrollment._id,
      productName: new RegExp(`^${escapeRegex(name)}$`, 'i'),
    }).lean();
    if (duplicate) {
      discardUpload(req.file);
      return sendError(res, {
        status: 409,
        message: `You already added "${duplicate.productName}".`,
      });
    }

    const imageUrl = await storeImage(req.file);
    const product = await Product.create({
      type: 'product',
      itemType: 'product',
      productName: name,
      sellingPrice: price,
      purchasePrice: 0,
      category,
      stockQty: stock,
      stockStatus: stock > 0 ? 'in_stock' : 'out_of_stock',
      discountType,
      discountValue,
      images: imageUrl ? [imageUrl] : [],
      imageUrl: imageUrl || null,
      isCsp: true,
      cspEnrollmentId: enrollment._id,
      cspCustomerId: enrollment.customerId,
      cspVendorId: enrollment.vendorId || null,
    });

    await invalidateProductSearchCache();
    return sendSuccess(res, {
      status: 201,
      message: 'Product added.',
      data: toProductDto(product),
    });
  } catch (error) {
    discardUpload(req.file);
    console.error('createMyCspProduct error:', error);
    return sendError(res, {
      status: error.status || 500,
      message: error.status ? error.message : 'Failed to add product.',
    });
  }
};

export const updateMyCspProduct = async (req, res) => {
  try {
    const customerId = req.customer?._id;
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      discardUpload(req.file);
      return sendError(res, {status: 400, message: 'Invalid product id.'});
    }

    const enrollment = await activeEnrollment(customerId);
    if (!enrollment) {
      discardUpload(req.file);
      return sendError(res, {
        status: 403,
        message: 'An approved CSP enrollment is required.',
      });
    }

    const product = await Product.findOne({
      _id: id,
      isCsp: true,
      cspEnrollmentId: enrollment._id,
    });
    if (!product) {
      discardUpload(req.file);
      return sendError(res, {status: 404, message: 'Product not found.'});
    }

    const parsed = readFields(req.body);
    if (parsed.error) {
      discardUpload(req.file);
      return sendError(res, {status: 400, message: parsed.error});
    }

    const {name, category, price, stock, discountType, discountValue} =
      parsed.value;
    const duplicate = await Product.findOne({
      _id: {$ne: product._id},
      isCsp: true,
      cspEnrollmentId: enrollment._id,
      productName: new RegExp(`^${escapeRegex(name)}$`, 'i'),
    }).lean();
    if (duplicate) {
      discardUpload(req.file);
      return sendError(res, {
        status: 409,
        message: `You already added "${duplicate.productName}".`,
      });
    }

    let imageUrl = product.imageUrl || '';
    if (req.file) {
      imageUrl = await storeImage(req.file);
    }
    if (!imageUrl) {
      return sendError(res, {
        status: 400,
        message: 'Please upload a product image.',
      });
    }

    product.productName = name;
    product.category = category;
    product.sellingPrice = price;
    product.stockQty = stock;
    product.stockStatus = stock > 0 ? 'in_stock' : 'out_of_stock';
    product.discountType = discountType;
    product.discountValue = discountValue;
    product.imageUrl = imageUrl;
    product.images = [imageUrl];
    product.isCsp = true;
    product.cspEnrollmentId = enrollment._id;
    product.cspCustomerId = enrollment.customerId;
    product.cspVendorId = enrollment.vendorId || null;
    await product.save();
    await invalidateProductSearchCache();

    return sendSuccess(res, {
      message: 'Product updated.',
      data: toProductDto(product),
    });
  } catch (error) {
    discardUpload(req.file);
    console.error('updateMyCspProduct error:', error);
    return sendError(res, {
      status: error.status || 500,
      message: error.status ? error.message : 'Failed to update product.',
    });
  }
};

export const deleteMyCspProduct = async (req, res) => {
  try {
    const customerId = req.customer?._id;
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return sendError(res, {status: 400, message: 'Invalid product id.'});
    }

    const enrollment = await activeEnrollment(customerId);
    if (!enrollment) {
      return sendError(res, {
        status: 403,
        message: 'An approved CSP enrollment is required.',
      });
    }

    const deleted = await Product.findOneAndDelete({
      _id: id,
      isCsp: true,
      cspEnrollmentId: enrollment._id,
    });
    if (!deleted) {
      return sendError(res, {status: 404, message: 'Product not found.'});
    }

    await invalidateProductSearchCache();
    return sendSuccess(res, {message: 'Product removed.', data: {id}});
  } catch (error) {
    console.error('deleteMyCspProduct error:', error);
    return sendError(res, {status: 500, message: 'Failed to remove product.'});
  }
};

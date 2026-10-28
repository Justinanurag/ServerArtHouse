import Product from '../models/product.model.js';
import Category from '../models/category.model.js';
import CustomersailorProgram from '../models/customerSellerProgram.model.js';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { computeStockByProductNames, getProductStockNames, sumStockForNames } from '../utils/inventoryStock.utils.js';
import { uploadOnCloudinary } from '../utils/cloudinary.js';
import mongoose from 'mongoose';
import {LINE_TYPES} from '../utils/itemClassification.utils.js';
import {
  invalidateProductSearchCache,
  rememberProductSearch,
} from '../config/productSearchCache.js';

const escapeRegex = (value) =>
  String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const namedVariantsOf = (product) =>
  (Array.isArray(product?.variants) ? product.variants : []).filter((v) =>
    String(v?.name ?? '').trim(),
  );

/**
 * After a product gains named variants, remove leftover parent-only docs
 * with the same product name (they show as empty-variant duplicates in POS).
 */
const removeParentOnlyDuplicatesForName = async (productName, keepId) => {
  const name = String(productName || '').trim();
  if (!name || !keepId) return 0;

  const siblings = await Product.find({
    _id: {$ne: keepId},
    productName: {$regex: `^${escapeRegex(name)}$`, $options: 'i'},
    type: {$ne: 'service'},
    itemType: {$ne: 'service'},
  }).select('_id productName variants');

  let removed = 0;
  for (const sib of siblings) {
    if (namedVariantsOf(sib).length > 0) continue;
    await Product.deleteOne({_id: sib._id});
    removed += 1;
  }
  return removed;
};
/**
 * Case-insensitive name lookup without giant $regex patterns
 * (MongoDB rejects regex patterns that are too long).
 */
const findByLowerNames = async (Model, field, names, selectFields) => {
  const lowers = [
    ...new Set(
      names
        .map((n) => String(n || '').trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  if (!lowers.length) return [];

  const CHUNK = 400;
  const results = [];
  for (let i = 0; i < lowers.length; i += CHUNK) {
    const chunk = lowers.slice(i, i + CHUNK);
    const docs = await Model.find({
      $expr: {
        $in: [{ $toLower: `$${field}` }, chunk],
      },
    })
      .select(selectFields)
      .lean();
    results.push(...docs);
  }
  return results;
};

/**
 * Ensure category names exist in Category collection (same as POST /api/categories).
 * Returns Map<lowerName, canonicalName>.
 */
const ensureCategoriesExist = async (names = []) => {
  const unique = [
    ...new Set(
      names
        .map((n) => String(n || '').trim())
        .filter(Boolean),
    ),
  ];
  const nameByLower = new Map();
  if (!unique.length) return nameByLower;

  const existing = await findByLowerNames(Category, 'name', unique, 'name');

  for (const cat of existing) {
    nameByLower.set(String(cat.name).trim().toLowerCase(), cat.name);
  }

  const missing = unique.filter(
    (name) => !nameByLower.has(name.toLowerCase()),
  );

  if (missing.length) {
    try {
      const created = await Category.insertMany(
        missing.map((name) => ({ name })),
        { ordered: false },
      );
      for (const cat of created) {
        nameByLower.set(String(cat.name).trim().toLowerCase(), cat.name);
      }
    } catch (error) {
      // Parallel uploads / unique race — re-read whatever exists now
      const again = await findByLowerNames(Category, 'name', missing, 'name');
      for (const cat of again) {
        nameByLower.set(String(cat.name).trim().toLowerCase(), cat.name);
      }
      // Keep requested casing for any still-missing (shouldn't happen often)
      for (const name of missing) {
        const key = name.toLowerCase();
        if (!nameByLower.has(key)) nameByLower.set(key, name);
      }
      if (error?.code !== 11000 && error?.name !== 'MongoBulkWriteError') {
        console.error('ensureCategoriesExist error:', error);
      }
    }
  }

  return nameByLower;
};

const parseBool = raw => {
  if (typeof raw === 'boolean') return raw;
  const v = String(raw ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'y';
};

const resolveCspFields = async ({ isCspRaw, cspEnrollmentIdRaw }) => {
  const isCsp = parseBool(isCspRaw);
  if (!isCsp) {
    return {
      isCsp: false,
      cspEnrollmentId: null,
      cspCustomerId: null,
      cspVendorId: null,
    };
  }

  const enrollmentId = String(cspEnrollmentIdRaw ?? '').trim();
  if (!enrollmentId || !mongoose.Types.ObjectId.isValid(enrollmentId)) {
    const error = new Error('CSP sailor is required when CSP is Yes.');
    error.status = 400;
    throw error;
  }

  const enrollment = await CustomersailorProgram.findOne({
    _id: enrollmentId,
    status: 'active',
  }).lean();

  if (!enrollment) {
    const error = new Error('Active CSP enrollment not found.');
    error.status = 400;
    throw error;
  }

  return {
    isCsp: true,
    cspEnrollmentId: enrollment._id,
    cspCustomerId: enrollment.customerId || null,
    cspVendorId: enrollment.vendorId || null,
  };
};

const withCspLabel = async products => {
  const list = Array.isArray(products) ? products : [];
  const enrollmentIds = [
    ...new Set(
      list
        .filter(p => p?.isCsp && p?.cspEnrollmentId)
        .map(p => String(p.cspEnrollmentId)),
    ),
  ];

  let enrollmentMap = new Map();
  if (enrollmentIds.length) {
    const rows = await CustomersailorProgram.find({
      _id: {$in: enrollmentIds},
    })
      .populate('customerId', 'name mobile')
      .populate('vendorId', 'name mobile')
      .lean();
    enrollmentMap = new Map(rows.map(r => [String(r._id), r]));
  }

  return list.map(product => {
    if (!product?.isCsp) {
      return {...product, cspLabel: null, cspSailorName: null};
    }
    const enrollment = enrollmentMap.get(String(product.cspEnrollmentId || ''));
    const sailorName =
      String(enrollment?.displayName || '').trim() ||
      String(enrollment?.customerId?.name || '').trim() ||
      String(enrollment?.vendorId?.name || '').trim() ||
      '';
    return {
      ...product,
      cspSailorName: sailorName || null,
      cspLabel: sailorName ? `CSP · ${sailorName}` : 'CSP',
    };
  });
};
const localUploadDir = path.resolve('uploads/products');
const tmpUploadDir = path.join('/tmp', 'uploads', 'products');

let uploadDir = localUploadDir;
try {
  fs.mkdirSync(localUploadDir, { recursive: true });
} catch (error) {
  // Fallback for read-only runtime filesystems (common in serverless envs).
  fs.mkdirSync(tmpUploadDir, { recursive: true });
  uploadDir = tmpUploadDir;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});

export const upload = multer({ storage });

//create product 
export const createProduct = async (req, res) => {
  try {
    const {
      type,
      productName,
      brandName,
      serviceName,
      sellingPrice,
      purchasePrice,
      itemCode,
      barCode,
      category,
      subCategory,
      stockQty,
      stockStatus,
      primaryUnit,
      description,
      discountType,
      discountValue,
      variants,
      isCsp,
      cspEnrollmentId,
    } = req.body;
    console.log("product controller",req.body);

    // Product routes always create products; Services routes set forceItemType='service'
    const forcedType = String(req.forceItemType || '').trim().toLowerCase();
    const itemType =
      forcedType === LINE_TYPES.SERVICE || forcedType === LINE_TYPES.PRODUCT
        ? forcedType
        : type === 'service'
          ? LINE_TYPES.SERVICE
          : LINE_TYPES.PRODUCT;
    // CSP only allowed on products
    if (itemType === LINE_TYPES.SERVICE) {
      req.body.isCsp = false;
    }
    const resolvedName = itemType === "service" ? serviceName || productName : productName;

    if (!resolvedName) {
      return res.status(400).json({
        success: false,
        message: "Name is required.",
      });
    }

    let cspFields;
    try {
      cspFields = await resolveCspFields({
        isCspRaw: isCsp,
        cspEnrollmentIdRaw: cspEnrollmentId,
      });
    } catch (cspError) {
      return res.status(cspError.status || 400).json({
        success: false,
        message: cspError.message || 'Invalid CSP selection.',
      });
    }

    let parsedVariants = [];
    if (variants) {
      try {
        const raw =
          typeof variants === 'string' ? JSON.parse(variants) : variants;
        parsedVariants = Array.isArray(raw)
          ? raw
              .map((v) => ({
                name: String(v?.name ?? '').trim(),
                sellingPrice: Math.max(0, Number(v?.sellingPrice) || 0),
                purchasePrice: Math.max(0, Number(v?.purchasePrice) || 0),
                barcode: String(v?.barcode ?? v?.barCode ?? '').trim(),
              }))
              .filter((v) => v.name)
          : [];
      } catch {
        parsedVariants = [];
      }
    }

    // Variant prices are source of truth; parent price optional when variants exist
    let parsedSellingPrice = Number(sellingPrice);
    let parsedPurchasePrice = purchasePrice ? Number(purchasePrice) : 0;
    if (!Number.isFinite(parsedSellingPrice)) parsedSellingPrice = 0;
    if (!Number.isFinite(parsedPurchasePrice)) parsedPurchasePrice = 0;

    if (itemType === 'product' && parsedVariants.length > 0) {
      const invalidVariant = parsedVariants.find((v) => !(v.sellingPrice > 0));
      if (invalidVariant) {
        return res.status(400).json({
          success: false,
          message: `Variant "${invalidVariant.name}" needs a selling price greater than 0.`,
        });
      }
      if (!(parsedSellingPrice > 0)) {
        parsedSellingPrice = parsedVariants[0].sellingPrice;
      }
      if (!(parsedPurchasePrice > 0)) {
        parsedPurchasePrice = parsedVariants[0].purchasePrice;
      }
    } else if (!(parsedSellingPrice > 0)) {
      return res.status(400).json({
        success: false,
        message:
          itemType === 'product'
            ? 'Selling price is required, or add variants with their own prices.'
            : 'Selling price is required.',
      });
    }

    const parsedDiscountValue = Number(discountValue || 0);
    if (discountType === "flat" && parsedDiscountValue > parsedSellingPrice) {
      return res.status(400).json({
        success: false,
        message: "Flat discount cannot exceed selling price.",
      });
    }
    if (discountType === "percentage" && parsedDiscountValue > 100) {
      return res.status(400).json({
        success: false,
        message: "Percentage discount cannot exceed 100.",
      });
    }

    let imageUrls = [];
    if (Array.isArray(req.files)) {
      for (const file of req.files) {
        const cloudinaryUrl = await uploadOnCloudinary(file.path);
        if (cloudinaryUrl) {
          imageUrls.push(cloudinaryUrl);
        } else {
          imageUrls.push(`/uploads/products/${file.filename}`);
        }
      }
    }

    // Block duplicate catalogue products (same name / item code / barcode).
    // Special case: parent-only product + new create with variants → merge into parent.
    if (itemType === 'product') {
      const nameLower = String(resolvedName).trim().toLowerCase();
      const code = String(itemCode || '').trim();
      const barcode = String(barCode || '').trim();
      const or = [{ productName: new RegExp(`^${nameLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }];
      if (code) or.push({ itemCode: code });
      if (barcode) or.push({ barCode: barcode }, { 'variants.barcode': barcode });
      const existingDup = await Product.findOne({
        itemType: { $ne: 'service' },
        $or: or,
      });

      if (existingDup) {
        const existingHasVariants = namedVariantsOf(existingDup).length > 0;
        const creatingWithVariants = parsedVariants.length > 0;

        // Adding first variant(s) onto an existing parent-only product → update in place
        if (!existingHasVariants && creatingWithVariants) {
          existingDup.sellingPrice = parsedSellingPrice;
          existingDup.purchasePrice = parsedPurchasePrice;
          existingDup.itemCode = itemCode || existingDup.itemCode;
          existingDup.barCode = barCode || existingDup.barCode;
          existingDup.brandName = brandName || existingDup.brandName;
          existingDup.category = category || existingDup.category;
          existingDup.subCategory = subCategory || existingDup.subCategory;
          existingDup.description = description || existingDup.description;
          existingDup.discountType = discountType || existingDup.discountType;
          existingDup.discountValue = parsedDiscountValue;
          existingDup.variants = parsedVariants;
          if (imageUrls.length) {
            existingDup.images = imageUrls;
            existingDup.imageUrl = imageUrls[0] || null;
          }
          Object.assign(existingDup, cspFields);
          await existingDup.save();
          await removeParentOnlyDuplicatesForName(
            existingDup.productName,
            existingDup._id,
          );

          const [productWithLabel] = await withCspLabel([existingDup.toObject()]);
          await invalidateProductSearchCache();
          return res.status(200).json({
            success: true,
            message:
              'Variants added to existing product (merged parent duplicate).',
            product: productWithLabel,
          });
        }

        return res.status(409).json({
          success: false,
          message: `Product already exists: "${existingDup.productName}". Duplicate products are not allowed.`,
        });
      }
    }

    const product = await Product.create({
      type: itemType,
      itemType,
      productName: resolvedName,
      brandName: brandName || "",
      serviceName: itemType === "service" ? resolvedName : "",
      sellingPrice: parsedSellingPrice,
      purchasePrice: parsedPurchasePrice,
      itemCode,
      barCode,
      category,
      subCategory,
      stockQty: 0,
      stockStatus: "out_of_stock",
      primaryUnit: itemType === "service" ? primaryUnit || "" : "",
      description: description || "",
      discountType: discountType || "flat",
      discountValue: parsedDiscountValue,
      variants: itemType === "product" ? parsedVariants : [],
      images: imageUrls,
      imageUrl: imageUrls[0] || null,
      ...cspFields,
    });

    if (itemType === 'product' && parsedVariants.length > 0) {
      await removeParentOnlyDuplicatesForName(product.productName, product._id);
    }

    const [productWithLabel] = await withCspLabel([product.toObject()]);
    await invalidateProductSearchCache();

    return res.status(201).json({
      success: true,
      message: 'Product created successfully',
      product: productWithLabel,
    });
  } catch (error) {
    console.error('createProduct error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create product',
    });
  }
};
export const uploadBulkProducts = async (req, res) => {
  try {
    const rawProducts = Array.isArray(req.body)
      ? req.body
      : Array.isArray(req.body?.products)
        ? req.body.products
        : [];

    if (!rawProducts.length) {
      return res.status(400).json({
        success: false,
        message: 'No products found',
      });
    }

    const toNumber = (value, fallback = 0) => {
      const n = Number(value);
      return Number.isFinite(n) ? n : fallback;
    };

    const normalizeKey = (value) =>
      String(value || '')
        .replace(/[\r\n\t]+/g, ' ')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');

    /** Clean barcode text (Excel often has trailing newlines / spaces). */
    const cleanBarcode = (value) =>
      String(value || '')
        .replace(/[\r\n\t]+/g, '')
        .trim();

    /**
     * Only real retail barcodes (EAN-8/UPC/EAN-13/GTIN-14) are globally unique.
     * Placeholder codes like "br33050xx" are shared across many variants and
     * must NOT block imports.
     */
    const uniqueBarcodeKey = (value) => {
      const digits = cleanBarcode(value).replace(/\s+/g, '');
      if (!/^\d{8,14}$/.test(digits)) return '';
      return digits;
    };

    /**
     * Split "Parent - Variant" style names used elsewhere in catalogue/stock.
     */
    const splitCombinedName = (productName) => {
      const raw = String(productName || '').trim();
      const idx = raw.indexOf(' - ');
      if (idx <= 0) return { parent: raw, variant: '' };
      return {
        parent: raw.slice(0, idx).trim(),
        variant: raw.slice(idx + 3).trim(),
      };
    };

    /** Primary identity for labels / reporting (name+variant → itemCode → numeric barcode). */
    const buildIdentity = ({ productName, variantName, itemCode, barCode }) => {
      const name = normalizeKey(productName);
      const variant = normalizeKey(variantName);
      if (name) {
        return {
          type: 'nameVariant',
          key: `name:${name}|variant:${variant}`,
          label: variant
            ? `Product "${productName}" / Variant "${variantName}"`
            : `Product "${productName}"`,
        };
      }

      const code = normalizeKey(itemCode);
      if (code) {
        return {
          type: 'itemCode',
          key: `item:${code}`,
          label: `Item Code "${itemCode}"`,
        };
      }

      const barcode = uniqueBarcodeKey(barCode);
      if (barcode) {
        return {
          type: 'barCode',
          key: `barcode:${barcode}`,
          label: `Barcode "${barcode}"`,
        };
      }

      return {
        type: 'nameVariant',
        key: `name:|variant:`,
        label: 'Unknown product',
      };
    };

    /**
     * Keys that should block a duplicate insert.
     * Primary: product name + variant (and "Name - Variant" catalogue form).
     * Also: itemCode when present; numeric EAN/UPC barcodes only.
     * Shared placeholder barcodes are ignored so multi-variant rows import.
     */
    const collectIdentityKeys = ({
      productName,
      variantName,
      itemCode,
      barCode,
    }) => {
      const keys = new Set();
      const code = normalizeKey(itemCode);
      if (code) keys.add(`item:${code}`);

      const barcode = uniqueBarcodeKey(barCode);
      if (barcode) keys.add(`barcode:${barcode}`);

      const name = normalizeKey(productName);
      const variant = normalizeKey(variantName);
      if (name) {
        keys.add(`name:${name}|variant:${variant}`);
        if (!variant) {
          // Same product name, no variant → treat as duplicate
          keys.add(`name:${name}`);
        } else {
          // Also match catalogue-style combined product names
          keys.add(`name:${normalizeKey(`${productName} - ${variantName}`)}`);
          keys.add(
            `name:${normalizeKey(`${productName} - ${variantName}`)}|variant:`,
          );
        }
      }

      // If productName is already "Parent - Variant", index both forms
      const split = splitCombinedName(productName);
      const parent = normalizeKey(split.parent);
      const splitVariant = normalizeKey(split.variant);
      if (parent && splitVariant && !variant) {
        keys.add(`name:${parent}|variant:${splitVariant}`);
        keys.add(`name:${normalizeKey(`${split.parent} - ${split.variant}`)}`);
        keys.add(
          `name:${normalizeKey(`${split.parent} - ${split.variant}`)}|variant:`,
        );
      }

      return [...keys];
    };

    const products = [];
    const invalidRows = [];
    const duplicateRows = [];
    const seenInFile = new Map(); // identity key → first row number

    // Auto-create any Excel categories via Category collection (POST /api/categories equivalent)
    const categoryNamesFromFile = rawProducts.map(
      (row) =>
        String(
          row?.category ?? row?.Category ?? row?.categoryName ?? '',
        ).trim() || 'Uncategorized',
    );
    const categoryMap = await ensureCategoriesExist(categoryNamesFromFile);

    rawProducts.forEach((row, index) => {
      const excelRow = index + 1;
      const productName = String(
        row?.productName ?? row?.Product ?? row?.name ?? '',
      ).trim();
      let sellingPrice = toNumber(
        row?.sellingPrice ?? row?.unitPrice ?? row?.['Unit Price'],
        NaN,
      );
      if (!(sellingPrice > 0)) {
        const taxPrice = toNumber(
          row?.['Price with Tax'] ?? row?.priceWithTax,
          NaN,
        );
        if (taxPrice > 0) sellingPrice = taxPrice;
      }
      const purchasePrice = toNumber(
        row?.purchasePrice ?? row?.['Purchase Price'],
        0,
      );
      const categoryRaw =
        String(
          row?.category ?? row?.Category ?? row?.categoryName ?? '',
        ).trim() || 'Uncategorized';
      const itemCode = String(row?.itemCode ?? row?.['Item Code'] ?? '').trim();
      const barCode = cleanBarcode(
        row?.barCode ?? row?.barcode ?? row?.Barcode ?? '',
      );
      const variantName = String(row?.variant ?? row?.Variant ?? '').trim();

      if (!productName || !(sellingPrice > 0)) {
        invalidRows.push({
          row: excelRow,
          productName: productName || null,
          reason: !productName
            ? 'Product name is required'
            : 'Selling / Unit Price must be greater than 0',
        });
        return;
      }

      const category =
        categoryMap.get(categoryRaw.toLowerCase()) || categoryRaw;

      let variants = [];
      if (Array.isArray(row?.variants)) {
        variants = row.variants
          .map((v) => ({
            name: String(v?.name ?? '').trim(),
            sellingPrice: toNumber(v?.sellingPrice, sellingPrice),
            purchasePrice: toNumber(v?.purchasePrice, purchasePrice),
            barcode: cleanBarcode(v?.barcode ?? v?.barCode ?? ''),
          }))
          .filter((v) => v.name);
      } else if (variantName) {
        variants = [
          {
            name: variantName,
            sellingPrice,
            purchasePrice,
            barcode: barCode,
          },
        ];
      }

      const resolvedVariantName =
        variantName || (variants[0]?.name ? String(variants[0].name) : '');
      const resolvedBarcode =
        barCode ||
        (variants[0]?.barcode ? cleanBarcode(variants[0].barcode) : '');

      const identity = buildIdentity({
        productName,
        variantName: resolvedVariantName,
        itemCode,
        barCode: resolvedBarcode,
      });
      const identityKeys = collectIdentityKeys({
        productName,
        variantName: resolvedVariantName,
        itemCode,
        barCode: resolvedBarcode,
      });

      const fileDupKey = identityKeys.find((k) => seenInFile.has(k));
      if (fileDupKey) {
        duplicateRows.push({
          row: excelRow,
          productName,
          reason: `Duplicate in file (${identity.label}). First seen on row ${seenInFile.get(fileDupKey)}.`,
        });
        return;
      }
      for (const k of identityKeys) {
        seenInFile.set(k, excelRow);
      }

      products.push({
        type: 'product',
        itemType: 'product',
        productName,
        brandName: String(row?.brandName ?? '').trim(),
        serviceName: '',
        sellingPrice,
        purchasePrice,
        itemCode,
        barCode: resolvedBarcode,
        category,
        subCategory: String(row?.subCategory ?? '').trim(),
        description: String(row?.description ?? '').trim(),
        discountType: row?.discountType === 'percentage' ? 'percentage' : 'flat',
        discountValue: Math.max(0, toNumber(row?.discountValue, 0)),
        stockQty: 0,
        stockStatus: 'out_of_stock',
        primaryUnit: '',
        variants,
        images: Array.isArray(row?.images) ? row.images : [],
        imageUrl: null,
        isCsp: false,
        cspEnrollmentId: null,
        _identity: identity,
        _identityKeys: identityKeys,
        _excelRow: excelRow,
      });
    });

    // Check against existing DB products
    const itemCodes = [
      ...new Set(
        products
          .map((p) => String(p.itemCode || '').trim())
          .filter(Boolean),
      ),
    ];
    // Only query DB by real numeric barcodes — placeholder codes are not unique
    const barCodes = [
      ...new Set(
        products
          .map((p) => uniqueBarcodeKey(p.barCode || ''))
          .filter(Boolean),
      ),
    ];
    const productNames = [
      ...new Set(
        products
          .flatMap((p) => {
            const base = String(p.productName || '').trim();
            const variant =
              Array.isArray(p.variants) && p.variants[0]?.name
                ? String(p.variants[0].name).trim()
                : '';
            const names = [base];
            if (variant) names.push(`${base} - ${variant}`);
            const split = splitCombinedName(base);
            if (split.parent) names.push(split.parent);
            if (split.parent && split.variant) {
              names.push(`${split.parent} - ${split.variant}`);
            }
            return names;
          })
          .filter(Boolean),
      ),
    ];

    const orClauses = [];
    if (itemCodes.length) orClauses.push({ itemCode: { $in: itemCodes } });
    if (barCodes.length) orClauses.push({ barCode: { $in: barCodes } });
    // Variant barcodes stored on nested variants
    if (barCodes.length) {
      orClauses.push({ 'variants.barcode': { $in: barCodes } });
    }

    // Prefer exact $in for codes; names use $toLower chunks (no giant regex)
    let existingProducts = [];
    if (orClauses.length) {
      existingProducts = await Product.find({
        itemType: { $ne: 'service' },
        $or: orClauses,
      })
        .select('productName itemCode barCode variants')
        .lean();
    }
    if (productNames.length) {
      const byName = await findByLowerNames(
        Product,
        'productName',
        productNames,
        'productName itemCode barCode variants itemType',
      );
      const seenIds = new Set(existingProducts.map((p) => String(p._id)));
      for (const doc of byName) {
        if (String(doc.itemType || doc.type || 'product') === 'service') {
          continue;
        }
        const id = String(doc._id);
        if (!seenIds.has(id)) {
          seenIds.add(id);
          existingProducts.push(doc);
        }
      }
    }

    const existingIdentities = new Set();
    for (const existing of existingProducts) {
      const existingVariants = Array.isArray(existing.variants)
        ? existing.variants
        : [];
      if (existingVariants.length > 0) {
        for (const variant of existingVariants) {
          for (const key of collectIdentityKeys({
            productName: existing.productName,
            variantName: variant?.name,
            itemCode: existing.itemCode,
            barCode: existing.barCode || variant?.barcode,
          })) {
            existingIdentities.add(key);
          }
        }
      } else {
        for (const key of collectIdentityKeys({
          productName: existing.productName,
          variantName: '',
          itemCode: existing.itemCode,
          barCode: existing.barCode,
        })) {
          existingIdentities.add(key);
        }
      }
    }

    const toInsert = [];
    for (const product of products) {
      const identity = product._identity;
      const identityKeys = Array.isArray(product._identityKeys)
        ? product._identityKeys
        : [identity.key];
      const excelRow = product._excelRow;
      delete product._identity;
      delete product._identityKeys;
      delete product._excelRow;

      const hit = identityKeys.find((k) => existingIdentities.has(k));
      if (hit) {
        duplicateRows.push({
          row: excelRow,
          productName: product.productName,
          reason: `Already exists in catalogue (${identity.label}).`,
        });
        continue;
      }

      // Mark so later rows in same request can't collide with ones we're inserting
      for (const k of identityKeys) {
        existingIdentities.add(k);
      }
      toInsert.push(product);
    }

    // Unique barCode index: placeholder codes like "br33050xx" are often reused.
    // Keep barcode on the first product only; clear later collisions so inserts succeed.
    const usedBarCodes = new Set();
    for (const existing of existingProducts) {
      const top = cleanBarcode(existing.barCode);
      if (top) usedBarCodes.add(top.toLowerCase());
      for (const v of Array.isArray(existing.variants) ? existing.variants : []) {
        const vb = cleanBarcode(v?.barcode);
        if (vb) usedBarCodes.add(vb.toLowerCase());
      }
    }
    for (const product of toInsert) {
      const bc = cleanBarcode(product.barCode);
      if (!bc) continue;
      const key = bc.toLowerCase();
      if (usedBarCodes.has(key)) {
        product.barCode = '';
        if (Array.isArray(product.variants)) {
          product.variants = product.variants.map((v) =>
            cleanBarcode(v?.barcode).toLowerCase() === key
              ? { ...v, barcode: '' }
              : v,
          );
        }
      } else {
        usedBarCodes.add(key);
      }
    }

    if (!toInsert.length) {
      return res.status(400).json({
        success: false,
        message:
          duplicateRows.length > 0
            ? 'All rows are duplicates or invalid. Nothing imported.'
            : 'No valid products to import',
        invalidRows,
        duplicateRows,
        summary: {
          total: rawProducts.length,
          created: 0,
          failed: invalidRows.length + duplicateRows.length,
          skippedDuplicates: duplicateRows.length,
          invalidRows,
          duplicateRows,
        },
      });
    }

    const insertedProducts = await Product.insertMany(toInsert, {
      ordered: false,
    });
    await invalidateProductSearchCache();

    return res.status(201).json({
      success: true,
      message: `${insertedProducts.length} products imported successfully`,
      products: insertedProducts,
      summary: {
        total: rawProducts.length,
        created: insertedProducts.length,
        failed: invalidRows.length + duplicateRows.length,
        skippedDuplicates: duplicateRows.length,
        invalidRows,
        duplicateRows,
      },
    });
  } catch (error) {
    console.error('uploadBulkProducts error:', error);

    // Partial success when ordered:false hits a validation / unique-index error mid-batch
    if (error?.name === 'MongoBulkWriteError' && Array.isArray(error?.insertedDocs)) {
      const created = error.insertedDocs.length;
      if (created > 0) await invalidateProductSearchCache();
      const writeErrors = Array.isArray(error?.writeErrors) ? error.writeErrors : [];
      const dupErrors = writeErrors.filter(
        (e) => e?.code === 11000 || /duplicate/i.test(String(e?.errmsg || e?.message || '')),
      );
      return res.status(207).json({
        success: created > 0,
        message: `Imported ${created} product(s); skipped ${dupErrors.length} duplicate(s)`,
        products: error.insertedDocs,
        summary: {
          created,
          failed: writeErrors.length,
          skippedDuplicates: dupErrors.length,
          errors: writeErrors.map((e) => e?.errmsg || e?.message),
        },
      });
    }

    return res.status(500).json({
      success: false,
      message: error?.message || 'Failed to import products',
    });
  }
};

const PRODUCT_LIST_SELECT = [
  'type',
  'itemType',
  'productName',
  'brandName',
  'serviceName',
  'sellingPrice',
  'purchasePrice',
  'itemCode',
  'barCode',
  'category',
  'subCategory',
  'primaryUnit',
  'description',
  'discountType',
  'discountValue',
  'stockQty',
  'stockStatus',
  'variants',
  'images',
  'imageUrl',
  'isCsp',
  'cspEnrollmentId',
  'createdAt',
  'updatedAt',
].join(' ');

const ALLOWED_PRODUCT_SORT = new Set([
  'createdAt',
  'updatedAt',
  'productName',
  'sellingPrice',
  'purchasePrice',
  'category',
  'stockQty',
]);

/**
 * Paginated product list with server-side search/sort.
 * Query: page, limit|size, skip|start, search, type, sortBy, sortDir, includeStats
 */
export const getProducts = async (req, res) => {
  try {
    const {
      search,
      type,
      page: pageRaw,
      limit: limitRaw,
      size: sizeRaw,
      skip: skipRaw,
      start: startRaw,
      sortBy: sortByRaw,
      sortDir: sortDirRaw,
      includeStats,
      cspEnrollmentId: cspEnrollmentIdRaw,
    } = req.query;

    const clauses = [];

    // Filter by CSP enrollment ID (shows all products for a CSP owner)
    const cspEnrollmentIdFilter = String(cspEnrollmentIdRaw || '').trim();
    if (cspEnrollmentIdFilter && mongoose.Types.ObjectId.isValid(cspEnrollmentIdFilter)) {
      clauses.push({ cspEnrollmentId: new mongoose.Types.ObjectId(cspEnrollmentIdFilter) });
    }

    // Optional type filter: product | service (omit = all)
    const typeFilter = String(type || '').trim().toLowerCase();
    if (typeFilter === 'product' || typeFilter === 'service') {
      clauses.push({
        $or: [{ type: typeFilter }, { itemType: typeFilter }],
      });
    }

    const searchTerm = String(search || '').trim();
    if (searchTerm) {
      const searchRegex = new RegExp(escapeRegex(searchTerm), 'i');
      clauses.push({
        $or: [
          { productName: searchRegex },
          { serviceName: searchRegex },
          { itemCode: searchRegex },
          { barCode: searchRegex },
          { category: searchRegex },
          { 'variants.name': searchRegex },
          { 'variants.barcode': searchRegex },
        ],
      });
    }

    const query =
      clauses.length === 0
        ? {}
        : clauses.length === 1
          ? clauses[0]
          : { $and: clauses };

    const parsedLimit = Number(limitRaw ?? sizeRaw);
    // When filtering by CSP enrollment, allow up to 2000 so all products are returned
    const limitCap = cspEnrollmentIdFilter ? 2000 : 100;
    const limit = Math.min(
      Math.max(Number.isFinite(parsedLimit) ? Math.trunc(parsedLimit) : (cspEnrollmentIdFilter ? 2000 : 50), 1),
      limitCap,
    );

    const parsedSkip = Number(skipRaw ?? startRaw);
    const parsedPage = Number(pageRaw);
    let page = 1;
    let skip = 0;
    if (Number.isFinite(parsedSkip) && parsedSkip >= 0) {
      skip = Math.trunc(parsedSkip);
      page = Math.floor(skip / limit) + 1;
    } else if (Number.isFinite(parsedPage) && parsedPage >= 1) {
      page = Math.trunc(parsedPage);
      skip = (page - 1) * limit;
    }

    const sortField = ALLOWED_PRODUCT_SORT.has(String(sortByRaw || ''))
      ? String(sortByRaw)
      : 'createdAt';
    const sortDir =
      String(sortDirRaw || '').toLowerCase() === 'asc' ? 1 : -1;
    const sort = { [sortField]: sortDir, _id: sortDir };

    const wantStats =
      String(includeStats || '').toLowerCase() === 'true' ||
      String(includeStats || '') === '1';

    const {total, products, statsAgg} = await rememberProductSearch(
      'staff-list',
      {
        search: searchTerm.toLowerCase(),
        type: typeFilter,
        cspEnrollmentId: cspEnrollmentIdFilter,
        page,
        limit,
        skip,
        sortField,
        sortDir,
        wantStats,
      },
      async () => {
        const [totalCount, rows, stats] = await Promise.all([
          Product.countDocuments(query),
          Product.find(query)
            .select(PRODUCT_LIST_SELECT)
            .sort(sort)
            .skip(skip)
            .limit(limit)
            .lean(),
          wantStats
            ? Product.aggregate([
                {$match: query},
                {
                  $group: {
                    _id: null,
                    totalStockQty: {$sum: {$ifNull: ['$stockQty', 0]}},
                    inStockCount: {
                      $sum: {
                        $cond: [{$gt: [{$ifNull: ['$stockQty', 0]}, 0]}, 1, 0],
                      },
                    },
                    outOfStockCount: {
                      $sum: {
                        $cond: [{$lte: [{$ifNull: ['$stockQty', 0]}, 0]}, 1, 0],
                      },
                    },
                    categories: {$addToSet: '$category'},
                  },
                },
              ])
            : Promise.resolve([]),
        ]);
        return {total: totalCount, products: rows, statsAgg: stats};
      },
      value =>
        Boolean(value) &&
        Array.isArray(value.products) &&
        Number.isFinite(Number(value.total)) &&
        Array.isArray(value.statsAgg),
    );

    const productNames = [
      ...new Set(products.flatMap((p) => getProductStockNames(p))),
    ];
    const stockMap = await computeStockByProductNames({ names: productNames });

    const productsWithLiveStock = products.map((product) => {
      const isService =
        product.itemType === 'service' || product.type === 'service';
      const liveStockQty = isService
        ? 0
        : sumStockForNames(stockMap, getProductStockNames(product));

      return {
        ...product,
        stockQty: liveStockQty,
        stockStatus: liveStockQty > 0 ? 'in_stock' : 'out_of_stock',
      };
    });

    const productsWithCsp = await withCspLabel(productsWithLiveStock);
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
    const hasMore = skip + productsWithCsp.length < total;

    const payload = {
      success: true,
      products: productsWithCsp,
      pagination: {
        page,
        limit,
        skip,
        total,
        totalPages,
        hasMore,
      },
      // Backward-compatible aliases used by some clients
      meta: {
        totalRowCount: total,
        page,
        limit,
        hasMore,
      },
    };

    if (wantStats) {
      const row = Array.isArray(statsAgg) ? statsAgg[0] : null;
      const categories = Array.isArray(row?.categories) ? row.categories : [];
      payload.stats = {
        totalProducts: total,
        totalStockQty: Number(row?.totalStockQty || 0),
        inStockCount: Number(row?.inStockCount || 0),
        outOfStockCount: Number(row?.outOfStockCount || 0),
        categoryCount: categories.filter((c) => String(c || '').trim()).length,
      };
    }

    return res.status(200).json(payload);
  } catch (error) {
    console.error('getProducts error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch products',
    });
  }
};
const CUSTOMER_PRODUCT_SELECT =
  'productName brandName sellingPrice category subCategory description discountType discountValue images imageUrl createdAt primaryUnit stockStatus';

const customerCatalogueFilter = () => ({
  type: {$ne: 'service'},
  itemType: {$ne: 'service'},
});

/** Public catalogue shape. Omits cost, barcodes, stock counts, and staff or customer ids. */
const serializeCustomerProduct = product => {
  const images = Array.isArray(product.images)
    ? product.images.map(url => String(url || '').trim()).filter(Boolean)
    : [];
  const imageUrl = String(product.imageUrl || '').trim() || images[0] || null;
  const availability =
    product.stockStatus === 'out_of_stock' ? 'out_of_stock' : 'in_stock';
  return {
    _id: product._id,
    name: String(product.productName || '').trim(),
    brandName: String(product.brandName || '').trim(),
    price: Math.max(0, Number(product.sellingPrice) || 0),
    category: String(product.category || '').trim(),
    subCategory: String(product.subCategory || '').trim(),
    description: String(product.description || '').trim(),
    unit: String(product.primaryUnit || '').trim(),
    discountType: product.discountType || 'flat',
    discountValue: Math.max(0, Number(product.discountValue) || 0),
    availability,
    imageUrl,
    images,
    createdAt: product.createdAt,
  };
};

/** Public catalogue for the customer supplies modal. No cost price or staff fields. */
export const getCustomerProducts = async (req, res) => {
  try {
    const limit = Math.min(
      Math.max(Number(req.query.limit) || 100, 1),
      200,
    );
    const search = String(req.query.search || '').trim();
    const category = String(req.query.category || '').trim();
    const filter = customerCatalogueFilter();
    if (category && category.toLowerCase() !== 'all') {
      filter.category = category;
    }
    if (search) {
      const searchRegex = new RegExp(escapeRegex(search), 'i');
      filter.$or = [
        {productName: searchRegex},
        {brandName: searchRegex},
        {category: searchRegex},
        {subCategory: searchRegex},
      ];
    }

    const catalogue = await rememberProductSearch(
      'customer-catalogue',
      {
        search: search.toLowerCase(),
        category: category.toLowerCase(),
        limit,
      },
      async () => {
        const [products, categoryNames] = await Promise.all([
          Product.find(filter)
            .select(CUSTOMER_PRODUCT_SELECT)
            .sort({createdAt: -1})
            .limit(limit)
            .lean(),
          Product.distinct('category', customerCatalogueFilter()),
        ]);
        return {
          categories: categoryNames
            .map(name => String(name || '').trim())
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b)),
          products: products.map(serializeCustomerProduct),
        };
      },
      value =>
        Boolean(value) &&
        Array.isArray(value.products) &&
        Array.isArray(value.categories),
    );

    return res.status(200).json({
      success: true,
      categories: catalogue.categories,
      products: catalogue.products,
    });
  } catch (error) {
    console.error('getCustomerProducts error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch products',
    });
  }
};

/** One public product for a shared link. Same safe fields as the catalogue. */
export const getCustomerProductById = async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }
    const product = await Product.findOne({
      _id: id,
      ...customerCatalogueFilter(),
    })
      .select(CUSTOMER_PRODUCT_SELECT)
      .lean();
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
      });
    }
    return res.status(200).json({
      success: true,
      product: serializeCustomerProduct(product),
    });
  } catch (error) {
    console.error('getCustomerProductById error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch product',
    });
  }
};

export const getProductsById = async (req, res) => {
  try {
    const { id } = req.params;

    const product = await Product.findById(id)
      .select(PRODUCT_LIST_SELECT)
      .lean();

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    const isService =
      product.itemType === "service" || product.type === "service";

    const productNames = getProductStockNames(product);

    const stockMap = await computeStockByProductNames({
      names: productNames,
    });

    const liveStockQty = isService
      ? 0
      : sumStockForNames(stockMap, productNames);

    const productWithLiveStock = {
      ...product,
      stockQty: liveStockQty,
      stockStatus:
        liveStockQty > 0 ? "in_stock" : "out_of_stock",
    };

    const [productWithCsp] = await withCspLabel([
      productWithLiveStock,
    ]);

    return res.status(200).json({
      success: true,
      product: productWithCsp,
    });
  } catch (error) {
    console.error("getProductsById error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch product",
    });
  }
};

//Edit product detail
export const updateProduct = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      type,
      productName,
      brandName,
      serviceName,
      sellingPrice,
      purchasePrice,
      itemCode,
      barCode,
      category,
      subCategory,
      stockQty,
      stockStatus,
      primaryUnit,
      description,
      discountType,
      discountValue,
      variants,
      isCsp,
      cspEnrollmentId,
    } = req.body;

    // find existing product
    const existingProduct = await Product.findById(id);

    if (!existingProduct) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    const existingIsService =
      existingProduct.itemType === 'service' || existingProduct.type === 'service';
    const forcedTypeEarly = String(req.forceItemType || '').trim().toLowerCase();
    if (forcedTypeEarly === 'product' && existingIsService) {
      return res.status(404).json({
        success: false,
        message: 'Product not found. Use Services API to update services.',
      });
    }
    if (forcedTypeEarly === 'service' && !existingIsService) {
      return res.status(404).json({
        success: false,
        message: 'Service not found.',
      });
    }

    if (isCsp !== undefined || cspEnrollmentId !== undefined) {
      try {
        const cspFields = await resolveCspFields({
          isCspRaw: isCsp !== undefined ? isCsp : existingProduct.isCsp,
          cspEnrollmentIdRaw:
            cspEnrollmentId !== undefined
              ? cspEnrollmentId
              : existingProduct.cspEnrollmentId,
        });
        existingProduct.isCsp = cspFields.isCsp;
        existingProduct.cspEnrollmentId = cspFields.cspEnrollmentId;
        existingProduct.cspCustomerId = cspFields.cspCustomerId;
        existingProduct.cspVendorId = cspFields.cspVendorId;
      } catch (cspError) {
        return res.status(cspError.status || 400).json({
          success: false,
          message: cspError.message || 'Invalid CSP selection.',
        });
      }
    }

    let imageUrls = existingProduct.images || [];
    if (Array.isArray(req.files) && req.files.length > 0) {
      imageUrls = [];
      for (const file of req.files) {
        const cloudinaryUrl = await uploadOnCloudinary(file.path);
        if (cloudinaryUrl) {
          imageUrls.push(cloudinaryUrl);
        } else {
          imageUrls.push(`/uploads/products/${file.filename}`);
        }
      }
    }

    // update fields — never convert product↔service unless forceItemType says so
    const forcedType = String(req.forceItemType || '').trim().toLowerCase();
    let nextType;
    if (forcedType === LINE_TYPES.SERVICE || forcedType === LINE_TYPES.PRODUCT) {
      nextType = forcedType;
    } else {
      // Keep existing type; ignore client attempts to reclassify via /products
      const existingType =
        existingProduct.itemType === 'service' || existingProduct.type === 'service'
          ? LINE_TYPES.SERVICE
          : LINE_TYPES.PRODUCT;
      nextType = existingType;
    }
    existingProduct.type = nextType;
    existingProduct.itemType = nextType;
    const nextName =
      nextType === "service"
        ? serviceName ?? productName ?? existingProduct.serviceName ?? existingProduct.productName
        : productName ?? serviceName ?? existingProduct.productName;
    existingProduct.productName = nextName;
    existingProduct.serviceName = nextType === "service" ? nextName : "";
    existingProduct.sellingPrice =
      sellingPrice !== undefined ? Number(sellingPrice) : existingProduct.sellingPrice;

    existingProduct.purchasePrice =
      purchasePrice !== undefined ? Number(purchasePrice) : existingProduct.purchasePrice;

    existingProduct.itemCode = itemCode ?? existingProduct.itemCode;
    existingProduct.barCode = barCode ?? existingProduct.barCode;
    existingProduct.brandName = brandName ?? existingProduct.brandName;
    existingProduct.category = category ?? existingProduct.category;
    existingProduct.subCategory = subCategory ?? existingProduct.subCategory;
    // Stock qty/status come from purchases/sales movements — do not overwrite from product form
    existingProduct.primaryUnit = primaryUnit ?? existingProduct.primaryUnit;
    existingProduct.description = description ?? existingProduct.description;
    existingProduct.discountType = discountType ?? existingProduct.discountType;
    existingProduct.discountValue =
      discountValue !== undefined ? Number(discountValue) : existingProduct.discountValue;

    if (nextType === "service") {
      existingProduct.stockQty = 0;
      existingProduct.variants = [];
    } else {
      // Keep stored stockQty as-is; live inventory is computed from purchases/invoices
      if (variants !== undefined) {
        try {
          const raw =
            typeof variants === 'string' ? JSON.parse(variants) : variants;
          const normalized = Array.isArray(raw)
            ? raw
                .map((v) => ({
                  name: String(v?.name ?? '').trim(),
                  sellingPrice: Math.max(0, Number(v?.sellingPrice) || 0),
                  purchasePrice: Math.max(0, Number(v?.purchasePrice) || 0),
                  barcode: String(v?.barcode ?? v?.barCode ?? '').trim(),
                }))
                .filter((v) => v.name)
            : [];
          // Preserve each variant's own prices — never overwrite with parent price
          existingProduct.variants = normalized;
          if (
            normalized.length > 0 &&
            !(Number(existingProduct.sellingPrice) > 0)
          ) {
            existingProduct.sellingPrice = normalized[0].sellingPrice;
          }
          if (
            normalized.length > 0 &&
            !(Number(existingProduct.purchasePrice) > 0)
          ) {
            existingProduct.purchasePrice = normalized[0].purchasePrice;
          }
        } catch {
          // keep existing variants on parse failure
        }
      }
    }

    existingProduct.images = imageUrls;
    existingProduct.imageUrl = imageUrls[0] || null;

    await existingProduct.save();

    if (namedVariantsOf(existingProduct).length > 0) {
      await removeParentOnlyDuplicatesForName(
        existingProduct.productName,
        existingProduct._id,
      );
    }

    const [productWithLabel] = await withCspLabel([existingProduct.toObject()]);
    await invalidateProductSearchCache();

    return res.status(200).json({
      success: true,
      message: "Product updated successfully",
      product: productWithLabel,
    });
  } catch (error) {
    console.error("updateProduct error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to update product",
    });
  }
};

//Delete product 
export const deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;

    const deletedProduct = await Product.findByIdAndDelete(id);

    if (!deletedProduct) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    await invalidateProductSearchCache();
    return res.status(200).json({
      success: true,
      message: "Product deleted successfully",
    });
  } catch (error) {
    console.error("deleteProduct error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to delete product",
    });
  }
};
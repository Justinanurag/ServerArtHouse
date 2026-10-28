import mongoose from 'mongoose';
import PurchaseOrder from '../models/purchaseOrder.model.js';
import {resolvePurchasePaymentFields} from '../utils/purchasePayment.utils.js';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {uploadOnCloudinary} from '../utils/cloudinary.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const localUploadsDir = path.resolve(__dirname, '../../uploads/purchaseOrder');
const tmpUploadsDir = path.join('/tmp', 'uploads', 'purchaseOrder');

let uploadsDir = localUploadsDir;
try {
  fs.mkdirSync(localUploadsDir, {recursive: true});
} catch (error) {
  fs.mkdirSync(tmpUploadsDir, {recursive: true});
  uploadsDir = tmpUploadsDir;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + file.originalname.replace(/\s+/g, '');
    cb(null, uniqueName);
  },
});

export const uploadPurchaseOrderAttachments = multer({
  storage,
  limits: {fileSize: 5 * 1024 * 1024}, // 5MB
});

export const createPurchaseOrder = async (req, res) => {
  try {
    const {
      invoiceNumber,
      invoiceDate,
      supplierName,
      vendorDate,
      amount,
      paymentMode,
      status,
      purchaseType,
      paidAmount,
      dueAmount,
      items,
      notes,
      purchaser,
      purchaserDate,
      purchaserSignature,
      supplierSignature,
      supplierDate,
      supplierAddress,
      supplierContact,
      manualDiscount,
      manualDiscountType,
    } = req.body;
    // console.log("purchase order controller",req.body);

    if (!invoiceNumber || !invoiceDate || !supplierName || !vendorDate) {
      return res.status(400).json({
        success: false,
        message:
          'Invoice number, invoice date, supplier, and vendor date are required.',
      });
    }

    let itemsList = items;
    if (typeof items === 'string') {
      try {
        itemsList = JSON.parse(items);
      } catch (e) {
        itemsList = [];
      }
    }

    const normalizedItems = Array.isArray(itemsList)
      ? itemsList.map(item => {
          const qty = Number(item.qty);
          const unitPrice = Number(item.unitPrice);
          const discount = Number(item.discount ?? 0);
          return {
            productName: String(item.productName ?? '').trim(),
            qty,
            unitPrice,
            discount,
            lineTotal: qty * unitPrice - discount,
          };
        })
      : [];
    const purchaseOrderPRefix = 'PURCHASE ODR:';
    const amountNum = Number(amount ?? 0);
    const paymentFields = resolvePurchasePaymentFields({
      amount: amountNum,
      paymentMode,
      status,
      purchaseType,
      paidAmount,
      dueAmount,
    });
    const purchaseOrder = await PurchaseOrder.create({
      invoiceNumber: purchaseOrderPRefix + String(invoiceNumber).trim(),

      invoiceDate: invoiceDate ? new Date(invoiceDate) : null,

      supplierName: String(supplierName).trim(),

      vendorDate: vendorDate ? new Date(vendorDate) : null,

      amount: amountNum,

      manualDiscount: Math.max(0, Number(manualDiscount ?? 0) || 0),

      manualDiscountType:
        String(manualDiscountType ?? 'flat') === 'percentage'
          ? 'percentage'
          : 'flat',

      purchaseType: paymentFields.purchaseType,

      paymentMode: paymentFields.paymentMode,

      status: paymentFields.status,

      paidAmount: paymentFields.paidAmount,

      dueAmount: paymentFields.dueAmount,

      items: normalizedItems,

      notes: String(notes ?? '').trim(),

      purchaser: String(purchaser ?? '').trim(),

      purchaserDate: purchaserDate ? new Date(purchaserDate) : undefined,

      purchaserSignature: String(purchaserSignature ?? '').trim(),

      supplierSignature: String(supplierSignature ?? '').trim(),

      supplierDate: supplierDate ? new Date(supplierDate) : undefined,

      supplierAddress: String(supplierAddress ?? '').trim(),

      supplierContact: String(supplierContact ?? '').trim(),
    });

    if (req.files && req.files.length > 0) {
      const uploadPromises = req.files.map(file =>
        uploadOnCloudinary(file.path),
      );
      const cloudinaryUrls = await Promise.all(uploadPromises);
      purchaseOrder.attachments = cloudinaryUrls.filter(url => url !== null);
      await purchaseOrder.save();
    }
    console.log('purchase order insert', purchaseOrder);

    return res.status(201).json({success: true, purchaseOrder});
  } catch (error) {
    return res.status(500).json({success: false, message: error.message});
  }
};

export const getPurchasesOrder = async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 2000, 1), 5000);
    const fromDate = String(req.query.fromDate ?? '').trim();
    const toDate = String(req.query.toDate ?? '').trim();
    const query = {};
    const dateFilter = {};
    if (fromDate) {
      const from = new Date(`${fromDate}T00:00:00.000`);
      if (!Number.isNaN(from.getTime())) dateFilter.$gte = from;
    }
    if (toDate) {
      const to = new Date(`${toDate}T23:59:59.999`);
      if (!Number.isNaN(to.getTime())) dateFilter.$lte = to;
    }
    if (Object.keys(dateFilter).length) {
      query.createdAt = dateFilter;
    }
    const purchaseOrders = await PurchaseOrder.find(query)
      .sort({createdAt: -1})
      .limit(limit)
      .lean();
    return res
      .status(200)
      .json({
        success: true,
        purchaseOrders,
        total: purchaseOrders.length,
        limit,
      });
  } catch (error) {
    return res.status(500).json({success: false, message: error.message});
  }
};

export const getPurchaseOrderById = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({success: false, message: 'Invalid purchase order id.'});
    }
    const purchaseOrder = await PurchaseOrder.findById(id);
    if (!purchaseOrder) {
      return res
        .status(404)
        .json({success: false, message: 'Purchase order not found.'});
    }
    return res.status(200).json({success: true, purchaseOrder});
  } catch (error) {
    return res.status(500).json({success: false, message: error.message});
  }
};

export const updatePurchaseOrder = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({success: false, message: 'Invalid purchase order id.'});
    }

    const body = req.body || {};
    const $set = {};

    if (body.invoiceNumber !== undefined) {
      $set.invoiceNumber = String(body.invoiceNumber).trim();
    }
    if (body.invoiceDate) {
      const d = new Date(body.invoiceDate);
      if (Number.isNaN(d.getTime())) {
        return res
          .status(400)
          .json({success: false, message: 'Invalid invoice date.'});
      }
      $set.invoiceDate = d;
    }
    if (body.vendorDate) {
      const d = new Date(body.vendorDate);
      if (Number.isNaN(d.getTime())) {
        return res
          .status(400)
          .json({success: false, message: 'Invalid vendor date.'});
      }
      $set.vendorDate = d;
    }
    if (body.supplierName !== undefined) {
      $set.supplierName = String(body.supplierName).trim();
    }
    if (body.supplierAddress !== undefined) {
      $set.supplierAddress = String(body.supplierAddress).trim();
    }
    if (body.supplierContact !== undefined) {
      $set.supplierContact = String(body.supplierContact).trim();
    }
    if (body.amount !== undefined) {
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount < 0) {
        return res
          .status(400)
          .json({success: false, message: 'Invalid amount.'});
      }
      $set.amount = amount;
    }
    if (body.manualDiscount !== undefined) {
      $set.manualDiscount = Math.max(0, Number(body.manualDiscount ?? 0) || 0);
    }
    if (body.manualDiscountType !== undefined) {
      $set.manualDiscountType =
        String(body.manualDiscountType ?? 'flat') === 'percentage'
          ? 'percentage'
          : 'flat';
    }
    if (
      body.status !== undefined ||
      body.paymentMode !== undefined ||
      body.purchaseType !== undefined ||
      body.paidAmount !== undefined ||
      body.dueAmount !== undefined
    ) {
      const existing = await PurchaseOrder.findById(id).select(
        'amount paymentMode status purchaseType paidAmount dueAmount',
      );
      if (!existing) {
        return res
          .status(404)
          .json({success: false, message: 'Purchase order not found.'});
      }
      const paymentFields = resolvePurchasePaymentFields({
        amount:
          body.amount !== undefined
            ? Number(body.amount)
            : Number(existing.amount),
        paymentMode:
          body.paymentMode !== undefined
            ? body.paymentMode
            : existing.paymentMode,
        status: body.status !== undefined ? body.status : existing.status,
        purchaseType:
          body.purchaseType !== undefined
            ? body.purchaseType
            : existing.purchaseType,
        paidAmount:
          body.paidAmount !== undefined ? body.paidAmount : existing.paidAmount,
        dueAmount:
          body.dueAmount !== undefined ? body.dueAmount : existing.dueAmount,
      });
      $set.purchaseType = paymentFields.purchaseType;
      $set.paymentMode = paymentFields.paymentMode;
      $set.status = paymentFields.status;
      $set.paidAmount = paymentFields.paidAmount;
      $set.dueAmount = paymentFields.dueAmount;
    }
    if (body.notes !== undefined) $set.notes = String(body.notes ?? '').trim();
    if (body.purchaser !== undefined) {
      $set.purchaser = String(body.purchaser ?? '').trim();
    }
    if (body.purchaserSignature !== undefined) {
      $set.purchaserSignature = String(body.purchaserSignature ?? '').trim();
    }
    if (body.supplierSignature !== undefined) {
      $set.supplierSignature = String(body.supplierSignature ?? '').trim();
    }
    if (body.purchaserDate) {
      const d = new Date(body.purchaserDate);
      if (!Number.isNaN(d.getTime())) $set.purchaserDate = d;
    }
    if (body.supplierDate) {
      const d = new Date(body.supplierDate);
      if (!Number.isNaN(d.getTime())) $set.supplierDate = d;
    }

    let itemsList = body.items;
    if (typeof itemsList === 'string') {
      try {
        itemsList = JSON.parse(itemsList);
      } catch {
        itemsList = undefined;
      }
    }
    if (Array.isArray(itemsList)) {
      $set.items = itemsList.map(item => {
        const qty = Number(item.qty);
        const unitPrice = Number(item.unitPrice);
        const discount = Number(item.discount ?? 0);
        return {
          productName: String(item.productName ?? '').trim(),
          qty,
          unitPrice,
          discount,
          lineTotal: qty * unitPrice - discount,
        };
      });
    }

    const updateOps = {};
    if (Object.keys($set).length) updateOps.$set = $set;

    if (req.files && req.files.length > 0) {
      const uploadPromises = req.files.map(file =>
        uploadOnCloudinary(file.path),
      );
      const cloudinaryUrls = await Promise.all(uploadPromises);
      const validUrls = cloudinaryUrls.filter(url => url !== null);
      if (validUrls.length) {
        // Must be a sibling of $set — never nested inside $set
        updateOps.$push = {attachments: {$each: validUrls}};
      }
    }

    if (!Object.keys(updateOps).length) {
      return res.status(400).json({
        success: false,
        message: 'No valid fields to update.',
      });
    }

    const purchaseOrder = await PurchaseOrder.findByIdAndUpdate(id, updateOps, {
      new: true,
      runValidators: true,
    });
    if (!purchaseOrder) {
      return res
        .status(404)
        .json({success: false, message: 'Purchase order not found.'});
    }
    return res.status(200).json({success: true, purchaseOrder});
  } catch (error) {
    console.error('updatePurchaseOrder error:', error);
    // Duplicate invoice number
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'A purchase order with this invoice number already exists.',
      });
    }
    return res.status(500).json({success: false, message: error.message});
  }
};

export const deletePurchaseOrder = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({success: false, message: 'Invalid purchase order id.'});
    }
    const purchaseOrder = await PurchaseOrder.findByIdAndDelete(id);
    if (!purchaseOrder) {
      return res
        .status(404)
        .json({success: false, message: 'Purchase order not found.'});
    }
    return res.status(200).json({success: true, purchaseOrder});
  } catch (error) {
    return res.status(500).json({success: false, message: error.message});
  }
};

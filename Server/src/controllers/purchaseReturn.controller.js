import mongoose from "mongoose";
import PurchaseReturn from "../models/purchaseReturn.model.js";
import { resolvePurchasePaymentFields } from "../utils/purchasePayment.utils.js";

export const createPurchaseReturn = async (req, res) => {
    try {
        const {
            invoiceNumber,
            invoiceDate,
            supplierName,
            purchaser,
            vendorDate,
            amount,
            paymentMode,
            status,
            purchaseType,
            paidAmount,
            dueAmount,
            items,
            notes,
        } = req.body;
console.log("createPurchaseReturn controller:",req.body)
        if (!invoiceNumber || !invoiceDate || !supplierName || !vendorDate) {
            return res.status(400).json({
                success: false,
                message: "Invoice number, invoice date, supplier, and vendor date are required.",
            });
        }

        const normalizedItems = Array.isArray(items)
            ? items.map((item) => {
                const qty = Number(item.qty);
                const unitPrice = Number(item.unitPrice);
                const discount = Number(item.discount ?? 0);
                return {
                    productName: String(item.productName ?? "").trim(), 
                    qty,
                    unitPrice,
                    discount,
                    lineTotal: qty * unitPrice - discount,
                };
            })
            : [];
        const purchaseReturnPrefix="PURRETURN:";
        const amountNum = Number(amount ?? 0);
        const paymentFields = resolvePurchasePaymentFields({
            amount: amountNum,
            paymentMode,
            status,
            purchaseType,
            paidAmount,
            dueAmount,
        });
        const purchaseReturn = await PurchaseReturn.create({
            invoiceNumber: purchaseReturnPrefix + String(invoiceNumber).trim(),
            invoiceDate: new Date(invoiceDate),
            purchaser: String(purchaser).trim(),
            supplierName: String(supplierName).trim(),
            vendorDate: new Date(vendorDate),
            amount: amountNum,
            purchaseType: paymentFields.purchaseType,
            paymentMode: paymentFields.paymentMode,
            status: paymentFields.status,
            paidAmount: paymentFields.paidAmount,
            dueAmount: paymentFields.dueAmount,
            items: normalizedItems,
            notes: String(notes ?? "").trim(),
        });

        return res.status(201).json({
            success: true,
            message: "Purchase return created successfully.",
            purchaseReturn,
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

export const getPurchaseReturns = async (req, res) => {
    try {
        const limit = Math.min(Math.max(Number(req.query.limit) || 2000, 1), 5000);
        const  fromDate=String(req.query.fromDate ?? '').trim();
        const toDate=String(req.query.toDate ?? '').trim();
        const query={};
        const dateFilter={};
        if(fromDate){
            const from=new Date(`${fromDate}T00:00:00.000`);
            if(!Number.isNaN(from.getTime())) dateFilter.$gte=from;
        }
        if(toDate){
            const to=new Date(`${toDate}T23:59:59.999`);
            if(!Number.isNaN(to.getTime())) dateFilter.$lte=to;
        }
        if(Object.keys(dateFilter).length){
            query.createdAt=dateFilter;
        }
        const purchaseReturns = await PurchaseReturn.find(query).sort({ createdAt: -1 })
            .limit(limit)
            .lean();
        return res.status(200).json({
            success: true,
            message: "Purchase returns fetched successfully.",
            purchaseReturns,
            total: purchaseReturns.length,
            limit,
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

export const getPurchaseReturnById = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: "Invalid purchase return id." });
        }
        const purchaseReturn = await PurchaseReturn.findById(id);
        if (!purchaseReturn) {
            return res.status(404).json({ success: false, message: "Purchase return not found." });
        }
        return res.status(200).json({ success: true, purchaseReturn });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
}

export const deletePurchaseReturn = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: "Invalid purchase return id." });
        }
        const purchaseReturn = await PurchaseReturn.findByIdAndDelete(id);
        if (!purchaseReturn) {
            return res.status(404).json({ success: false, message: "Purchase return not found." });
        }
        return res.status(200).json({ success: true, purchaseReturn });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
}

export const updatePurchaseReturn = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ success: false, message: "Invalid purchase return id." });
        }
        const updateData = { ...req.body };
        if (updateData.invoiceDate) updateData.invoiceDate = new Date(updateData.invoiceDate);
        if (updateData.vendorDate) updateData.vendorDate = new Date(updateData.vendorDate);
        if (Array.isArray(updateData.items)) {
            updateData.items = updateData.items.map((item) => {
                const qty = Number(item.qty);
                const unitPrice = Number(item.unitPrice);
                const discount = Number(item.discount ?? 0);
                return {
                    productName: String(item.productName ?? "").trim(),
                    qty,
                    unitPrice,
                    discount,
                    lineTotal: qty * unitPrice - discount,
                };
            });
        }
        const purchaseReturn = await PurchaseReturn.findByIdAndUpdate(id, { $set: updateData }, { new: true });
        if (!purchaseReturn) {
            return res.status(404).json({ success: false, message: "Purchase return not found." });
        }
        return res.status(200).json({
            success: true,
            message: "Purchase return updated successfully.",
            purchaseReturn,
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
}
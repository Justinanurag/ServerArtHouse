import Counter from '../models/counter.model.js';
import Customer from '../models/customer.model.js';
import Coupon from '../models/coupon.model.js';
import Quotation from '../models/quotation.model.js';
import { validateCouponForOrder } from './coupon.controller.js';
import {
  isCustomerMembershipExpired,
  MEMBERSHIP_EXPIRED_MESSAGE,
} from '../services/membershipEligibility.service.js';

const getStartOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const getNextQuotationNumber = async () => {
  const counter = await Counter.findOneAndUpdate(
    {key: 'quotation_number'},
    {$inc: {value: 1}},
    {new: true, upsert: true, setDefaultsOnInsert: true},
  );
  return counter.value;
};

const buildCreatedBy = (req, fallback = {}) => ({
  m_staff_id: fallback?.m_staff_id ?? req.user?.userId ?? null,
  m_staff_name: fallback?.m_staff_name ?? req.user?.name ?? null,
  m_staff_email: fallback?.m_staff_email ?? req.user?.email ?? null,
});

const findCustomerForQuotation = async ({ customerPhone, customerName }) => {
  const phone = String(customerPhone ?? '').trim();
  if (phone) {
    const byPhone = await Customer.findOne({ mobile: phone });
    if (byPhone) return byPhone;
  }

  const name = String(customerName ?? '').trim();
  if (name) {
    return Customer.findOne({ name });
  }

  return null;
};

const createQuotation = async (req, res) => {
  try {
    const {
      customerName,
      customerPhone,
      quotationDate,
      dueDate,
      salesPersonName,
      notes,
      items,
      subTotal,
      discountTotal,
      grandTotal,
      status,
      createdBy,
      coupon,
      membershipType,
      membershipPlanId,
      membershipDiscount,
      cashbackTotal,
      extraCharges,
    } = req.body;

    if (!customerName || !quotationDate || !dueDate || !salesPersonName || !customerPhone) {
      return res.status(400).json({
        success: false,
        message: 'Customer, quotation date, due date, and sales person are required.',
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one quotation item is required.',
      });
    }

    const quotationDateObj = new Date(quotationDate);
    const dueDateObj = new Date(dueDate);
    if (Number.isNaN(quotationDateObj.getTime()) || Number.isNaN(dueDateObj.getTime())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid quotation date or due date.',
      });
    }

    if (dueDateObj < getStartOfToday()) {
      return res.status(400).json({
        success: false,
        message: 'Due date cannot be before today.',
      });
    }

    const normalizedItems = items.map(item => {
      const qty = Number(item.qty);
      const unitPrice = Number(item.unitPrice);
      const discount = Number(item.discount ?? 0);
      const cashback = Number(item.cashback ?? 0);
      const lineTotal = qty * unitPrice - discount;
      return {
        productName: String(item.productName ?? '').trim(),
        qty,
        unitPrice,
        discount,
        cashback: Number.isFinite(cashback) && cashback > 0 ? cashback : 0,
        category: String(item.category ?? 'General').trim() || 'General',
        isCsp: Boolean(item.isCsp),
        productDiscountType: String(item.productDiscountType ?? '').trim(),
        productDiscountValue: Number(item.productDiscountValue ?? 0) || 0,
        productDiscountAmount: Number(item.productDiscountAmount ?? 0) || 0,
        membershipDiscountAmount: Number(item.membershipDiscountAmount ?? 0) || 0,
        lineTotal,
      };
    });

    if (normalizedItems.some(item => !item.productName || item.qty <= 0 || item.unitPrice < 0 || item.discount < 0 || item.lineTotal < 0)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid quotation item values.',
      });
    }

    const quotationCustomer = await findCustomerForQuotation({customerPhone, customerName});
    const quotationUsesMembership =
      Math.max(0, Number(membershipDiscount) || 0) > 0 ||
      Math.max(0, Number(cashbackTotal) || 0) > 0 ||
      normalizedItems.some(
        item =>
          !item.isCsp &&
          (item.membershipDiscountAmount > 0 || item.cashback > 0),
      );
    if (quotationUsesMembership && (await isCustomerMembershipExpired(quotationCustomer))) {
      return res.status(400).json({
        success: false,
        code: 'MEMBERSHIP_EXPIRED',
        message: MEMBERSHIP_EXPIRED_MESSAGE,
      });
    }

    const computedSubTotal = normalizedItems.reduce(
      (sum, item) => sum + Number(item.qty ?? 0) * Number(item.unitPrice ?? 0),
      0,
    );
    const itemDiscountTotal = normalizedItems.reduce(
      (sum, item) => sum + Number(item.discount ?? 0),
      0,
    );

    let appliedCoupon = null;
    let couponDiscount = 0;
    const preCouponAmount = Math.max(0, computedSubTotal - itemDiscountTotal);
    if (coupon?.code) {
      const couponValidation = await validateCouponForOrder({
        code: coupon.code,
        orderAmount: preCouponAmount,
        customerPhone,
        items: req.body.items || normalizedItems,
      });
      if (!couponValidation.ok) {
        return res.status(400).json({
          success: false,
          message: couponValidation.message,
        });
      }
      appliedCoupon = couponValidation.coupon;
      couponDiscount = Number(couponValidation.discountAmount ?? 0);
    }

    const computedDiscountTotal = itemDiscountTotal + couponDiscount;
    const computedGrandTotal = Math.max(0, computedSubTotal - computedDiscountTotal);
    const computedCashbackTotal = normalizedItems.reduce(
      (sum, item) => sum + Number(item.cashback ?? 0),
      0,
    );
    const computedMembershipDiscount = normalizedItems.reduce(
      (sum, item) => sum + Number(item.membershipDiscountAmount ?? 0),
      0,
    );

    const nextNumber = await getNextQuotationNumber();
    const quotationPrefix = 'QUOTVWAH';
    const quotationCode = `${quotationPrefix}-${nextNumber}`;
    const actor = buildCreatedBy(req, createdBy);

    const quotation = await Quotation.create({
      quotationPrefix,
      quotationNumber: nextNumber,
      quotationCode,
      customerName: String(customerName).trim(),
      customerPhone: String(customerPhone).trim(),
      quotationDate: quotationDateObj,
      dueDate: dueDateObj,
      salesPersonName: String(salesPersonName).trim(),
      notes: String(notes ?? '').trim(),
      status: status || 'draft',
      items: normalizedItems,
      subTotal: Number(subTotal ?? computedSubTotal),
      discountTotal: Number(discountTotal ?? computedDiscountTotal),
      membershipType: String(membershipType ?? '').trim(),
      membershipPlanId: String(membershipPlanId ?? '').trim(),
      membershipDiscount: Number(membershipDiscount ?? computedMembershipDiscount) || 0,
      cashbackTotal: Number(cashbackTotal ?? computedCashbackTotal) || 0,
      extraCharges: Array.isArray(extraCharges)
        ? extraCharges.map((c) => ({
            label: String(c?.label ?? 'Extra Charge').trim() || 'Extra Charge',
            amount: Number(c?.amount ?? 0) || 0,
          }))
        : [],
      coupon: appliedCoupon
        ? {
            code: appliedCoupon.code,
            title: appliedCoupon.title,
            discountType: appliedCoupon.discountType,
            discountValue: Number(appliedCoupon.discountValue ?? 0),
            discountAmount: couponDiscount,
          }
        : undefined,
      grandTotal: Number(grandTotal ?? computedGrandTotal),
      createdBy: actor,
    });

    return res.status(201).json({
      success: true,
      message: 'Quotation created successfully.',
      quotation,
    });
  } catch (error) {
    console.error('createQuotation error:', error);
    return res.status(500).json({
      success: false,
      message: 'Quotation creation failed.',
    });
  }
};

const getQuotations = async (req, res) => {
  try {
    const fromDate=String(req.query.fromDate ?? '').trim();
    const toDate=String(req.query.toDate ?? '').trim();
    const limit=Math.min(Math.max(Number(req.query.limit) || 2000, 1), 5000);
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
    const quotations = await Quotation.find(query)
    .sort({createdAt: -1})
    .limit(limit)
    .lean();
    return res.status(200).json({
      success: true,
      message: 'Quotations fetched successfully.',
      quotations,
      total: quotations.length,
      limit,
    });
  } catch (error) {
    console.error('getQuotations error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch quotations.',
    });
  }
};

const deleteQuotation = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Quotation ID is required",
      });
    }

    const deletedQuotation = await Quotation.findOneAndDelete({ _id: id });

    if (!deletedQuotation) {
      return res.status(404).json({
        success: false,
        message: "Quotation not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "Quotation deleted successfully",
      deletedQuotation,
    });

  } catch (error) {
    console.error("deleteQuotation error:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to delete quotation",
    });
  }
};

const updateQuotation = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, message: "Quotation ID is required" });
    }

    const {
      customerName,
      customerPhone,
      quotationDate,
      dueDate,
      salesPersonName,
      notes,
      items,
      subTotal,
      discountTotal,
      grandTotal,
      status,
      coupon,
      membershipType,
      membershipPlanId,
      membershipDiscount,
      cashbackTotal,
      extraCharges,
    } = req.body;

    const existingQuotation = await Quotation.findById(id);
    if (!existingQuotation) {
      return res.status(404).json({ success: false, message: "Quotation not found" });
    }

    const quotationDateObj = quotationDate ? new Date(quotationDate) : undefined;
    const dueDateObj = dueDate ? new Date(dueDate) : undefined;

    let normalizedItems;
    if (items && Array.isArray(items)) {
      normalizedItems = items.map(item => {
        const qty = Number(item.qty);
        const unitPrice = Number(item.unitPrice);
        const discount = Number(item.discount ?? 0);
        const cashback = Number(item.cashback ?? 0);
        const lineTotal = qty * unitPrice - discount;
        return {
          productName: String(item.productName ?? '').trim(),
          qty,
          unitPrice,
          discount,
          cashback: Number.isFinite(cashback) && cashback > 0 ? cashback : 0,
          category: String(item.category ?? 'General').trim() || 'General',
          isCsp: Boolean(item.isCsp),
          productDiscountType: String(item.productDiscountType ?? '').trim(),
          productDiscountValue: Number(item.productDiscountValue ?? 0) || 0,
          productDiscountAmount: Number(item.productDiscountAmount ?? 0) || 0,
          membershipDiscountAmount: Number(item.membershipDiscountAmount ?? 0) || 0,
          lineTotal,
        };
      });
    }

    const quotationCustomer = await findCustomerForQuotation({
      customerPhone: customerPhone ?? existingQuotation.customerPhone,
      customerName: customerName ?? existingQuotation.customerName,
    });
    const quotationUsesMembership =
      Math.max(0, Number(membershipDiscount) || 0) > 0 ||
      Math.max(0, Number(cashbackTotal) || 0) > 0 ||
      (normalizedItems || []).some(
        item =>
          !item.isCsp &&
          (item.membershipDiscountAmount > 0 || item.cashback > 0),
      );
    const quotationBenefitTotal = source => {
      const rows = Array.isArray(source?.items) ? source.items : [];
      const header =
        Math.max(0, Number(source?.membershipDiscount) || 0) +
        Math.max(0, Number(source?.cashbackTotal) || 0);
      const lines = rows.reduce((sum, item) => {
        if (item?.isCsp) return sum;
        return (
          sum +
          Math.max(0, Number(item?.membershipDiscountAmount) || 0) +
          Math.max(0, Number(item?.cashback) || 0)
        );
      }, 0);
      return header + lines;
    };
    const incomingBenefitTotal = quotationBenefitTotal({
      items: normalizedItems || [],
      membershipDiscount,
      cashbackTotal,
    });
    const storedBenefitTotal = quotationBenefitTotal(existingQuotation);
    if (
      quotationUsesMembership &&
      incomingBenefitTotal > storedBenefitTotal + 0.009 &&
      (await isCustomerMembershipExpired(quotationCustomer))
    ) {
      return res.status(400).json({
        success: false,
        code: 'MEMBERSHIP_EXPIRED',
        message: MEMBERSHIP_EXPIRED_MESSAGE,
      });
    }

    const updateData = {};
    if (customerName !== undefined) updateData.customerName = String(customerName).trim();
    if (customerPhone !== undefined) updateData.customerPhone = String(customerPhone).trim();
    if (quotationDateObj !== undefined) updateData.quotationDate = quotationDateObj;
    if (dueDateObj !== undefined) updateData.dueDate = dueDateObj;
    if (salesPersonName !== undefined) updateData.salesPersonName = String(salesPersonName).trim();
    if (notes !== undefined) updateData.notes = String(notes).trim();
    if (normalizedItems !== undefined) updateData.items = normalizedItems;
    if (subTotal !== undefined) updateData.subTotal = Number(subTotal);
    if (discountTotal !== undefined) updateData.discountTotal = Number(discountTotal);
    if (grandTotal !== undefined) updateData.grandTotal = Number(grandTotal);
    if (status !== undefined) updateData.status = status;
    if (membershipType !== undefined) updateData.membershipType = String(membershipType).trim();
    if (membershipPlanId !== undefined) updateData.membershipPlanId = String(membershipPlanId ?? '').trim();
    if (membershipDiscount !== undefined) updateData.membershipDiscount = Number(membershipDiscount) || 0;
    if (cashbackTotal !== undefined) updateData.cashbackTotal = Number(cashbackTotal) || 0;
    if (extraCharges !== undefined) {
      updateData.extraCharges = Array.isArray(extraCharges)
        ? extraCharges.map((c) => ({
            label: String(c?.label ?? 'Extra Charge').trim() || 'Extra Charge',
            amount: Number(c?.amount ?? 0) || 0,
          }))
        : [];
    }

    let nextCouponPatch;
    if (coupon !== undefined) {
      if (!coupon?.code) {
        nextCouponPatch = {
          code: null,
          title: null,
          discountType: null,
          discountValue: 0,
          discountAmount: 0,
        };
      } else {
        const couponValidation = await validateCouponForOrder({
          code: coupon.code,
          orderAmount: Number(updateData.subTotal ?? existingQuotation.subTotal) - Number(updateData.discountTotal ?? existingQuotation.discountTotal ?? 0),
          customerPhone: String(updateData.customerPhone ?? existingQuotation.customerPhone ?? '').trim(),
          ignoreInvoiceId: id,
          items: updateData.items ?? existingQuotation.items,
        });
        if (!couponValidation.ok) {
          return res.status(400).json({
            success: false,
            message: couponValidation.message,
          });
        }
        nextCouponPatch = {
          code: couponValidation.coupon.code,
          title: couponValidation.coupon.title,
          discountType: couponValidation.coupon.discountType,
          discountValue: Number(couponValidation.coupon.discountValue ?? 0),
          discountAmount: Number(couponValidation.discountAmount ?? 0),
        };
      }
      updateData.coupon = nextCouponPatch;
    }

    const updatedQuotation = await Quotation.findByIdAndUpdate(
      id,
      { $set: updateData },
      { new: true }
    );

    return res.status(200).json({
      success: true,
      message: "Quotation updated successfully",
      quotation: updatedQuotation,
    });
  } catch (error) {
    console.error("updateQuotation error:", error);
    return res.status(500).json({ success: false, message: "Failed to update quotation" });
  }
};

const updateQuotationStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    if (!id) {
      return res.status(400).json({ success: false, message: "Quotation ID is required" });
    }
    if (!status) {
      return res.status(400).json({ success: false, message: "Status is required" });
    }

    const updatedQuotation = await Quotation.findByIdAndUpdate(
      id,
      { $set: { status } },
      { new: true }
    );

    if (!updatedQuotation) {
      return res.status(404).json({ success: false, message: "Quotation not found" });
    }

    return res.status(200).json({
      success: true,
      message: `Quotation marked as ${status}`,
      quotation: updatedQuotation,
    });
  } catch (error) {
    console.error("updateQuotationStatus error:", error);
    return res.status(500).json({ success: false, message: "Failed to update quotation status" });
  }
};

export { createQuotation, getQuotations, deleteQuotation, updateQuotation, updateQuotationStatus };

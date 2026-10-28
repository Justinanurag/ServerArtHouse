/**
 * Pure validation helpers for return sale HTTP bodies (no DB).
 * Mirrors Mongoose rules in `returnSale.model.js`.
 */

const MOBILE_RE = /^[6-9]\d{9}$/;

const getStartOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

export function validateReturnSaleCreateBody(body) {
  const errors = [];

  const {
    customerName,
    customerPhone,
    invoiceDate,
    dueDate,
    salesPersonName,
    billBy,
    invoiceBy,
    notes,
    items,
    subTotal,
    discountTotal,
    grandTotal,
    status,
    originalInvoiceId,
    createdBy,
    intent,
    refundMode,
    refundBreakdown,
    originalInvoiceCode,
  } = body ?? {};

  if (!customerName || !String(customerName).trim()) {
    errors.push('Customer name is required.');
  }
  if (!customerPhone || !String(customerPhone).trim()) {
    errors.push('Customer phone is required.');
  } else if (!MOBILE_RE.test(String(customerPhone).trim())) {
    errors.push('Invalid customer phone (10-digit Indian mobile).');
  }
  if (!salesPersonName || !String(salesPersonName).trim()) {
    errors.push('Sales person is required.');
  }

  const invoiceDateObj = invoiceDate ? new Date(invoiceDate) : null;
  const dueDateObj = dueDate ? new Date(dueDate) : null;
  if (!invoiceDateObj || Number.isNaN(invoiceDateObj.getTime())) {
    errors.push('Valid return / invoice date is required.');
  }
  if (!dueDateObj || Number.isNaN(dueDateObj.getTime())) {
    errors.push('Valid due date is required.');
  }
  if (invoiceDateObj && dueDateObj && dueDateObj < getStartOfToday()) {
    if (!originalInvoiceId) {
      errors.push('Due date cannot be before today.');
    }
  }

  if (!Array.isArray(items) || items.length === 0) {
    errors.push('At least one line item is required.');
  }

  let normalizedItems;
  if (Array.isArray(items) && items.length) {
    normalizedItems = items.map((item, idx) => {
      const qty = Number(item.qty);
      const unitPrice = Number(item.unitPrice);
      const discount = Number(item.discount ?? 0);
      const clientLineTotal = Number(item.lineTotal);
      const refundAmount = Number(item.refundAmount);
      // Prefer stored net / refund amount. Do not recalculate list − discount when net is known.
      const lineTotal =
        Number.isFinite(clientLineTotal) && clientLineTotal >= 0
          ? clientLineTotal
          : Number.isFinite(refundAmount) && refundAmount >= 0
            ? refundAmount
            : Math.max(0, qty * unitPrice - discount);
      const lineIndexRaw = item.lineIndex;
      const lineIndex =
        lineIndexRaw === null || lineIndexRaw === undefined || lineIndexRaw === ''
          ? null
          : Number(lineIndexRaw);
      return {
        productName: String(item.productName ?? '').trim(),
        qty,
        unitPrice,
        discount,
        lineTotal: Math.max(0, lineTotal),
        lineIndex: Number.isInteger(lineIndex) && lineIndex >= 0 ? lineIndex : null,
        originalQty: Math.max(0, Number(item.originalQty ?? 0) || 0),
        isGift: Boolean(item.isGift),
        refundAmount: Math.max(0, Number(item.refundAmount ?? 0) || 0),
        _idx: idx,
      };
    });

    const bad = normalizedItems.find(
      item =>
        !item.productName ||
        item.qty <= 0 ||
        item.unitPrice < 0 ||
        item.discount < 0 ||
        item.lineTotal < 0,
    );
    if (bad) {
      errors.push(`Invalid item at index ${bad._idx + 1}.`);
    }
    normalizedItems = normalizedItems.map(({_idx, ...rest}) => rest);
  }

  const st = Number(subTotal);
  const dt = Number(discountTotal ?? 0);
  const gt = Number(grandTotal);
  if (Number.isNaN(st) || st < 0) errors.push('Invalid subTotal.');
  if (Number.isNaN(dt) || dt < 0) errors.push('Invalid discountTotal.');
  if (Number.isNaN(gt) || gt < 0) errors.push('Invalid grandTotal.');

  if (errors.length) {
    return {ok: false, errors};
  }

  const allowedStatus = ['draft', 'final', 'cancelled'];
  const stNorm = allowedStatus.includes(status) ? status : 'final';

  const rawInvoiceBy =
    invoiceBy && typeof invoiceBy === 'object' ? invoiceBy : {};
  const invoiceByStaffName = String(
    rawInvoiceBy.staffName || rawInvoiceBy.name || '',
  ).trim();
  const resolvedBillBy = String(
    billBy || invoiceByStaffName || '',
  ).trim();
  const rawStaffId = rawInvoiceBy.staffId || rawInvoiceBy._id || null;
  const staffId =
    rawStaffId &&
    typeof rawStaffId === 'string' &&
    /^[a-fA-F0-9]{24}$/.test(rawStaffId)
      ? rawStaffId
      : rawStaffId && typeof rawStaffId === 'object'
        ? rawStaffId
        : null;

  return {
    ok: true,
    data: {
      customerName: String(customerName).trim(),
      customerPhone: String(customerPhone).trim(),
      invoiceDate: invoiceDateObj,
      dueDate: dueDateObj,
      salesPersonName: String(
        invoiceByStaffName || salesPersonName || '',
      ).trim(),
      billBy: resolvedBillBy,
      invoiceBy: {
        staffId,
        staffName: invoiceByStaffName || resolvedBillBy,
        employeeId: String(
          rawInvoiceBy.employeeId || rawInvoiceBy.m_staff_id || '',
        ).trim(),
        email: String(rawInvoiceBy.email || '').trim(),
      },
      notes: String(notes ?? '').trim(),
      items: normalizedItems,
      subTotal: st,
      discountTotal: dt,
      grandTotal: gt,
      status: stNorm,
      originalInvoiceId: originalInvoiceId || null,
      originalInvoiceCode: String(originalInvoiceCode ?? '').trim(),
      intent: intent === 'cancel' ? 'cancel' : 'return',
      refundMode: String(refundMode ?? '').trim(),
      refundBreakdown: {
        cash: Math.max(0, Number(refundBreakdown?.cash ?? 0) || 0),
        upi: Math.max(0, Number(refundBreakdown?.upi ?? 0) || 0),
        card: Math.max(0, Number(refundBreakdown?.card ?? 0) || 0),
        wallet: Math.max(0, Number(refundBreakdown?.wallet ?? 0) || 0),
        paidAmount: Math.max(0, Number(refundBreakdown?.paidAmount ?? 0) || 0),
      },
      createdBy:
        createdBy ?? null,
    },
  };
}

export function validateReturnSaleUpdateBody(body) {
  const errors = [];
  const update = {};

  const {
    customerName,
    customerPhone,
    invoiceDate,
    dueDate,
    salesPersonName,
    billBy,
    invoiceBy,
    notes,
    items,
    subTotal,
    discountTotal,
    grandTotal,
    status,
    originalInvoiceId,
  } = body ?? {};

  if (customerName !== undefined) {
    if (!String(customerName).trim()) errors.push('Customer name cannot be empty.');
    else update.customerName = String(customerName).trim();
  }
  if (customerPhone !== undefined) {
    const p = String(customerPhone).trim();
    if (!p) errors.push('Customer phone cannot be empty.');
    else if (!MOBILE_RE.test(p)) errors.push('Invalid customer phone.');
    else update.customerPhone = p;
  }
  if (salesPersonName !== undefined) {
    if (!String(salesPersonName).trim()) errors.push('Sales person cannot be empty.');
    else update.salesPersonName = String(salesPersonName).trim();
  }
  if (billBy !== undefined) {
    update.billBy = String(billBy ?? '').trim();
  }
  if (invoiceBy !== undefined) {
    const raw = invoiceBy && typeof invoiceBy === 'object' ? invoiceBy : {};
    update.invoiceBy = {
      staffId: raw.staffId || raw._id || null,
      staffName: String(raw.staffName || raw.name || '').trim(),
      employeeId: String(raw.employeeId || raw.m_staff_id || '').trim(),
      email: String(raw.email || '').trim(),
    };
    if (!update.billBy && update.invoiceBy.staffName) {
      update.billBy = update.invoiceBy.staffName;
    }
  }
  if (notes !== undefined) update.notes = String(notes).trim();

  if (invoiceDate !== undefined) {
    const d = new Date(invoiceDate);
    if (Number.isNaN(d.getTime())) errors.push('Invalid return / invoice date.');
    else update.invoiceDate = d;
  }
  if (dueDate !== undefined) {
    const d = new Date(dueDate);
    if (Number.isNaN(d.getTime())) errors.push('Invalid due date.');
    else {
      if (d < getStartOfToday()) errors.push('Due date cannot be before today.');
      update.dueDate = d;
    }
  }

  if (items !== undefined) {
    if (!Array.isArray(items) || !items.length) {
      errors.push('At least one line item is required when updating items.');
    } else {
      const normalizedItems = items.map(item => {
        const qty = Number(item.qty);
        const unitPrice = Number(item.unitPrice);
        const discount = Number(item.discount ?? 0);
        const clientLineTotal = Number(item.lineTotal);
        const refundAmount = Number(item.refundAmount);
        const lineTotal =
          Number.isFinite(clientLineTotal) && clientLineTotal >= 0
            ? clientLineTotal
            : Number.isFinite(refundAmount) && refundAmount >= 0
              ? refundAmount
              : Math.max(0, qty * unitPrice - discount);
        return {
          productName: String(item.productName ?? '').trim(),
          qty,
          unitPrice,
          discount,
          lineTotal: Math.max(0, lineTotal),
          refundAmount: Math.max(0, Number.isFinite(refundAmount) ? refundAmount : 0),
        };
      });
      if (
        normalizedItems.some(
          item =>
            !item.productName ||
            item.qty <= 0 ||
            item.unitPrice < 0 ||
            item.discount < 0 ||
            item.lineTotal < 0,
        )
      ) {
        errors.push('Invalid line item values.');
      } else {
        update.items = normalizedItems;
      }
    }
  }

  if (subTotal !== undefined) {
    const n = Number(subTotal);
    if (Number.isNaN(n) || n < 0) errors.push('Invalid subTotal.');
    else update.subTotal = n;
  }
  if (discountTotal !== undefined) {
    const n = Number(discountTotal);
    if (Number.isNaN(n) || n < 0) errors.push('Invalid discountTotal.');
    else update.discountTotal = n;
  }
  if (grandTotal !== undefined) {
    const n = Number(grandTotal);
    if (Number.isNaN(n) || n < 0) errors.push('Invalid grandTotal.');
    else update.grandTotal = n;
  }
  if (status !== undefined) {
    if (!['draft', 'final', 'cancelled'].includes(status)) {
      errors.push('Invalid status.');
    } else {
      update.status = status;
    }
  }
  if (originalInvoiceId !== undefined) {
    update.originalInvoiceId = originalInvoiceId || null;
  }

  if (errors.length) {
    return {ok: false, errors};
  }
  if (Object.keys(update).length === 0) {
    return {ok: false, errors: ['No valid fields to update.']};
  }

  return {ok: true, data: update};
}

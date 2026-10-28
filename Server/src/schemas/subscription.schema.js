const MOBILE_RE = /^[6-9]\d{9}$/;

const getStartOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

const toNumber = value => Number(value);
const normalizeMembershipType = value => String(value ?? '').trim().toLowerCase();
const isJuniorMembership = value => {
  const v = normalizeMembershipType(value);
  return v.includes('junior') || v.includes('junoir');
};

const normalizeRepeat = ({repeatType, repeatEvery, repeatUnit}, errors, isPatch = false) => {
  const hasAnyRepeatField =
    repeatType !== undefined || repeatEvery !== undefined || repeatUnit !== undefined;

  if (isPatch && !hasAnyRepeatField) {
    return {};
  }

  const nextRepeatType = ['weekly', 'monthly', 'yearly', 'lifetime'].includes(repeatType)
    ? repeatType
    : 'monthly';

  if (nextRepeatType === 'lifetime') {
    return {
      repeatType: 'lifetime',
      repeatEvery: null,
      repeatUnit: null,
    };
  }

  const every = repeatEvery === undefined || repeatEvery === null ? 1 : toNumber(repeatEvery);
  if (Number.isNaN(every) || every <= 0) {
    errors.push('repeatEvery must be greater than 0.');
  }

  const unit = nextRepeatType === 'yearly' ? 'year' : 'month';
  if (repeatUnit !== undefined && repeatUnit !== null && repeatUnit !== unit) {
    errors.push(`repeatUnit must be '${unit}' for ${nextRepeatType} repeatType.`);
  }

  return {
    repeatType: nextRepeatType,
    repeatEvery: every,
    repeatUnit: unit,
  };
};

const normalizeItems = (items, errors) => {
  if (!Array.isArray(items) || items.length === 0) {
    errors.push('At least one line item is required.');
    return [];
  }

  const normalized = items.map((item, idx) => {
    const qty = Number(item.qty);
    const unitPrice = Number(item.unitPrice);
    const discount = Number(item.discount ?? 0);
    const lineTotal = qty * unitPrice - discount;
    return {
      productName: String(item.productName ?? '').trim(),
      qty,
      unitPrice,
      discount,
      lineTotal,
      category: String(item.category ?? 'membership').trim() || 'membership',
      _idx: idx,
    };
  });

  const bad = normalized.find(
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

  return normalized.map(({_idx, ...rest}) => rest);
};

const normalizeStudents = (
  students,
  errors,
  isJunior,
  {allowOptionalJuniorStudents = false} = {},
) => {
  if (!isJunior) return [];
  if (!Array.isArray(students) || students.length === 0) {
    // Bulk junior import may leave student/parent columns blank
    if (allowOptionalJuniorStudents) return [];
    errors.push('At least one student is required for Junior membership.');
    return [];
  }

  return students.map((student, idx) => {
    const classStd = String(student?.classStd ?? '').trim();
    const normalized = {
      studentName: String(student?.studentName ?? '').trim(),
      schoolName: String(student?.schoolName ?? '').trim(),
      dob: student?.dob ? new Date(student.dob) : null,
      classStd,
      relation: String(student?.relation ?? '').trim(),
      parentName: String(student?.parentName ?? '').trim(),
      studentId: String(student?.studentId ?? '').trim(),
      studentIdUpload: String(student?.studentIdUpload ?? '').trim(),
    };

    if (!allowOptionalJuniorStudents) {
      if (!normalized.studentName) {
        errors.push(`Student name is required at row ${idx + 1}.`);
      }
      if (!normalized.classStd) {
        errors.push(
          `Class/STD must be less than or equal to class 12 at row ${idx + 1}.`,
        );
      }
      if (!normalized.relation) {
        errors.push(`Relation is required at row ${idx + 1}.`);
      }
      if (!normalized.parentName) {
        errors.push(`Parent name is required at row ${idx + 1}.`);
      }
      if (!normalized.studentId && !normalized.studentIdUpload) {
        errors.push(
          `Student ID or Photo Upload is required at row ${idx + 1}.`,
        );
      }
    }

    if (normalized.dob && Number.isNaN(normalized.dob.getTime())) {
      errors.push(`Invalid DOB at row ${idx + 1}.`);
    }

    return normalized;
  });
};

export function validateSubscriptionCreateBody(body) {
  const errors = [];
  const {
    customerName,
    customerPhone,
    invoiceDate,
    dueDate,
    salesPersonName,
    notes,
    items,
    subTotal,
    discountTotal,
    grandTotal,
    status,
    createdBy,
    repeatType,
    repeatEvery,
    repeatUnit,
    membershipId,
    priority,
    membershipPlanId,
    membershipType,
    students,
    referral,
    coupon,
    mode,
    paymentStatus,
    paymentBreakdown,
    allowPastEndDate,
    allowOptionalJuniorStudents,
  } = body ?? {};

  if (!customerName || !String(customerName).trim()) errors.push('Customer name is required.');
  if (!customerPhone || !String(customerPhone).trim()) {
    errors.push('Customer phone is required.');
  } else if (!MOBILE_RE.test(String(customerPhone).trim())) {
    errors.push('Invalid customer phone (10-digit Indian mobile).');
  }
  if (!salesPersonName || !String(salesPersonName).trim()) errors.push('Sales person is required.');

  // Parse YYYY-MM-DD as UTC calendar date to avoid timezone day-shift.
  const parseDateOnly = value => {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    const text = String(value ?? '').trim();
    const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) {
      return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    }
    const d = text ? new Date(text) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
  };

  const invoiceDateObj = parseDateOnly(invoiceDate);
  const dueDateObj = parseDateOnly(dueDate) || invoiceDateObj;
  if (!invoiceDateObj) errors.push('Valid start date is required.');
  if (!dueDateObj) errors.push('Valid end date is required.');
  // Bulk import of historical memberships may have past end dates.
  if (
    !allowPastEndDate &&
    invoiceDateObj &&
    dueDateObj &&
    dueDateObj < getStartOfToday()
  ) {
    errors.push('End date cannot be before today.');
  }
  if (invoiceDateObj && dueDateObj && dueDateObj < invoiceDateObj) {
    errors.push('End date cannot be before start date.');
  }

  const normalizedItems = normalizeItems(items, errors);
  const normalizedMembershipType = normalizeMembershipType(membershipType || membershipPlanId);
  const isJunior = isJuniorMembership(normalizedMembershipType);
  const normalizedStudents = normalizeStudents(students, errors, isJunior, {
    allowOptionalJuniorStudents: Boolean(allowOptionalJuniorStudents),
  });

  const st = Number(subTotal);
  const dt = Number(discountTotal ?? 0);
  const gt = Number(grandTotal);
  if (Number.isNaN(st) || st < 0) errors.push('Invalid subTotal.');
  if (Number.isNaN(dt) || dt < 0) errors.push('Invalid discountTotal.');
  if (Number.isNaN(gt) || gt < 0) errors.push('Invalid grandTotal.');

  const repeatData = normalizeRepeat({repeatType, repeatEvery, repeatUnit}, errors);

  if (errors.length) return {ok: false, errors};

  const allowedStatus = ['draft', 'active', 'completed', 'expired', 'error', 'cancelled'];
  const normalizedStatus = allowedStatus.includes(status) ? status : 'active';
  const normalizedPriority = Number(priority);
  const safePriority = Number.isFinite(normalizedPriority)
    ? Math.max(0, normalizedPriority)
    : 0;

  return {
    ok: true,
    data: {
      customerName: String(customerName).trim(),
      customerPhone: String(customerPhone).trim(),
      membershipId: String(membershipId ?? '').trim(),
      membershipPlanId: String(membershipPlanId ?? '').trim(),
      membershipType: normalizedMembershipType || 'general',
      priority: safePriority,
      invoiceDate: invoiceDateObj,
      dueDate: dueDateObj,
      startDate: invoiceDateObj,
      endDate: dueDateObj,
      salesPersonName: String(salesPersonName).trim(),
      notes: String(notes ?? '').trim(),
      items: normalizedItems,
      students: normalizedStudents,
      subTotal: st,
      discountTotal: dt,
      grandTotal: gt,
      status: normalizedStatus,
      createdBy: createdBy ?? null,
      referral: referral ?? null,
      coupon: coupon ?? null,
      mode: String(mode ?? '').trim(),
      paymentStatus: String(paymentStatus ?? '').trim() || 'Paid (Full)',
      paymentBreakdown: paymentBreakdown ?? null,
      ...repeatData,
    },
  };
}

export function validateSubscriptionUpdateBody(body) {
  const errors = [];
  const update = {};
  const {
    customerName,
    customerPhone,
    invoiceDate,
    dueDate,
    salesPersonName,
    notes,
    items,
    subTotal,
    discountTotal,
    grandTotal,
    status,
    createdBy,
    priority,
    repeatType,
    repeatEvery,
    repeatUnit,
    membershipId,
    membershipPlanId,
    membershipType,
    students,
    mode,
    paymentStatus,
    paymentBreakdown,
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
  if (notes !== undefined) update.notes = String(notes).trim();

  if (invoiceDate !== undefined) {
    const d = new Date(invoiceDate);
    if (Number.isNaN(d.getTime())) errors.push('Invalid start date.');
    else {
      update.invoiceDate = d;
      update.startDate = d;
    }
  }
  if (dueDate !== undefined) {
    const d = new Date(dueDate);
    if (Number.isNaN(d.getTime())) errors.push('Invalid end date.');
    else {
      if (d < getStartOfToday()) errors.push('End date cannot be before today.');
      update.dueDate = d;
      update.endDate = d;
    }
  }

  if (update.startDate && update.endDate && update.endDate < update.startDate) {
    errors.push('End date cannot be before start date.');
  }

  if (items !== undefined) {
    update.items = normalizeItems(items, errors);
  }
  if (membershipId !== undefined) update.membershipId = String(membershipId ?? '').trim();
  if (membershipPlanId !== undefined) {
    update.membershipPlanId = String(membershipPlanId ?? '').trim();
  }
  if (membershipType !== undefined) {
    update.membershipType = normalizeMembershipType(membershipType || 'general');
  }
  if (priority !== undefined) {
    const n = Number(priority);
    if (Number.isNaN(n) || n < 0) errors.push('Invalid priority.');
    else update.priority = n;
  }
  if (students !== undefined) {
    const currentMembershipType = update.membershipType ?? normalizeMembershipType(membershipType);
    const isJunior = isJuniorMembership(currentMembershipType);
    update.students = normalizeStudents(students, errors, isJunior);
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
    if (!['draft', 'active', 'completed', 'expired', 'error', 'cancelled'].includes(status)) {
      errors.push('Invalid status.');
    } else {
      update.status = status;
    }
  }
  if (createdBy !== undefined) update.createdBy = createdBy;
  if (mode !== undefined) update.mode = String(mode ?? '').trim();
  if (paymentStatus !== undefined) {
    update.paymentStatus = String(paymentStatus ?? '').trim() || 'Paid (Full)';
  }
  if (paymentBreakdown !== undefined) {
    update.paymentBreakdown = {
      cash: Math.max(0, Number(paymentBreakdown?.cash) || 0),
      upi: Math.max(0, Number(paymentBreakdown?.upi) || 0),
      card: Math.max(0, Number(paymentBreakdown?.card) || 0),
      wallet: Math.max(0, Number(paymentBreakdown?.wallet) || 0),
      paidAmount: Math.max(0, Number(paymentBreakdown?.paidAmount) || 0),
      dueAmount: Math.max(0, Number(paymentBreakdown?.dueAmount) || 0),
      changeAmount: Math.max(0, Number(paymentBreakdown?.changeAmount) || 0),
    };
  }

  const repeatData = normalizeRepeat({repeatType, repeatEvery, repeatUnit}, errors, true);
  Object.assign(update, repeatData);

  if (errors.length) return {ok: false, errors};
  if (Object.keys(update).length === 0) {
    return {ok: false, errors: ['No valid fields to update.']};
  }
  return {ok: true, data: update};
}

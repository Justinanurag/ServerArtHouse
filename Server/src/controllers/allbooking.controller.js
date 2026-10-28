import mongoose from 'mongoose';
import AllBooking from '../models/allBooking.model.js';
import Space from '../models/space.model.js';
import Food from '../models/food.model.js';
import AdditionalService from '../models/additionalService.model.js';
import Customer from '../models/customer.model.js';
import Membership from '../models/membership.model.js';
import {computeBookingStatus} from './spaceBooking.controller.js';
import {
  buildBookingIntervals,
  resolveSpaceGroup,
  validateAndPersistSchedule,
  BookingValidationError,
} from '../services/spaceBookingAvailability.service.js';
import {
  appliedBookingPayment,
  bookingPaymentError,
} from '../utils/bookingPayment.js';
import {getBookingPaymentRule} from '../services/bookingPaymentSettings.service.js';
import {isCustomerMembershipExpired} from '../services/membershipEligibility.service.js';

const STATUSES = new Set(['Upcoming', 'Ongoing', 'Expired', 'Cancelled', 'Draft']);
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_LIMIT = 100;

const last10 = value => String(value || '').replace(/\D/g, '').slice(-10);

const parseDate = value => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return new Date(`${raw}T00:00:00.000Z`);
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
};

const toDateKey = value => {
  if (!value) return '';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
};

const formatTimeDisplay = timeStr => {
  const match = String(timeStr || '').trim().match(TIME_RE);
  if (!match) return '';
  const hours = Number(match[1]);
  const period = hours >= 12 ? 'PM' : 'AM';
  const display = hours % 12 === 0 ? 12 : hours % 12;
  return `${display}:${match[2]} ${period}`;
};

const hoursBetween = (start, end) => {
  const startMatch = TIME_RE.exec(String(start || ''));
  const endMatch = TIME_RE.exec(String(end || ''));
  if (!startMatch || !endMatch) return 0;
  const minutes =
    Number(endMatch[1]) * 60 +
    Number(endMatch[2]) -
    (Number(startMatch[1]) * 60 + Number(startMatch[2]));
  if (minutes <= 0) return 0;
  return Math.round((minutes / 60) * 100) / 100;
};

const roundMoney = value => Math.round((Number(value) || 0) * 100) / 100;

const usageLimitsObject = plan => {
  const raw = plan?.usageLimits;
  if (!raw) return {};
  if (typeof raw.entries === 'function') return Object.fromEntries(raw.entries());
  return raw;
};

const benefitPercents = (plan, bucket) => {
  if (!plan) return {discount: 0, cashback: 0};
  const limits = usageLimitsObject(plan);
  const aliases =
    bucket === 'Space'
      ? ['space', 'spaces']
      : bucket === 'Food'
        ? ['food', 'foods']
        : ['service', 'services'];
  const key = Object.keys(limits).find(name => aliases.includes(String(name).toLowerCase()));
  const row = key ? limits[key] : null;
  let discount = Number(row?.discount) || 0;
  let cashback = Number(row?.cashback) || 0;
  const display = plan.customerDisplay || {};
  if (discount <= 0) {
    if (bucket === 'Space') discount = Number(display.spaceDiscountPercent) || 0;
    if (bucket === 'Food') discount = Number(display.foodDiscountPercent) || 0;
    if (bucket === 'Services') discount = Number(display.serviceDiscountPercent) || 0;
  }
  if (cashback <= 0 && bucket === 'Food') cashback = Number(display.cashbackPercent) || 0;
  return {discount, cashback};
};

const applyBenefit = (amount, percents) => {
  const base = Math.max(0, Number(amount) || 0);
  const discount =
    percents.discount > 0
      ? roundMoney((base * percents.discount) / 100)
      : 0;
  const cashback =
    percents.cashback > 0 ? roundMoney((base * percents.cashback) / 100) : 0;
  return {discount, cashback};
};

const findCustomer = async phone => {
  const digits = last10(phone);
  if (digits.length !== 10) return null;
  return Customer.findOne({
    $or: [
      {mobile: digits},
      {whatsappNumber: {$in: [digits, `+91${digits}`, `91${digits}`]}},
    ],
  })
    .select('name mobile email membershipType membershipPlanId membershipPurchase')
    .lean();
};

const findPlan = async customer => {
  const type = String(customer?.membershipType || '').trim();
  if (!customer || !type || type.toLowerCase() === 'none') return null;
  if (await isCustomerMembershipExpired(customer)) return null;
  if (customer.membershipPlanId && mongoose.Types.ObjectId.isValid(String(customer.membershipPlanId))) {
    const byId = await Membership.findOne({
      _id: customer.membershipPlanId,
      status: 'Active',
    }).lean();
    if (byId) return byId;
  }
  const pattern = new RegExp(`^${type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  return Membership.findOne({
    status: 'Active',
    $or: [{planId: pattern}, {displayName: pattern}],
  }).lean();
};

const lineText = lines =>
  (Array.isArray(lines) ? lines : [])
    .map(line => `${line.label} × ${line.qty}`)
    .join(', ');

const serialize = (doc, customer) => {
  const plain = typeof doc?.toObject === 'function' ? doc.toObject() : {...doc};
  const spaceBits = [plain.spaceName, plain.spaceType, plain.spaceDay].filter(Boolean);
  const startTime = plain.startTime || '';
  const endTime = plain.endTime || '';
  return {
    id: String(plain._id),
    sourceId: String(plain._id),
    bookingCode: plain.bookingCode || `AB-${String(plain._id).slice(-6).toUpperCase()}`,
    customerId: plain.customerId ? String(plain.customerId) : '',
    customerName: plain.customerName || '',
    customerPhone: plain.customerPhone || '',
    customerEmail: plain.customerEmail || customer?.email || '',
    customer: customer
      ? {
          id: String(customer._id),
          name: customer.name || '',
          phone: customer.mobile || '',
          email: customer.email || '',
          membershipType: customer.membershipType || '',
        }
      : null,
    spaceId: plain.spaceId ? String(plain.spaceId) : '',
    spaceDetails: spaceBits.join(' · '),
    spaceName: plain.spaceName || '',
    spaceType: plain.spaceType || '',
    spaceCategory: plain.spaceCategory || '',
    spaceDay: plain.spaceDay || '',
    unitPrice: Number(plain.unitPrice) || 0,
    spaceQty: Number(plain.spaceQty) || 1,
    durationHours: Number(plain.durationHours) || 0,
    bookingDate: plain.bookingDate || null,
    startTime,
    endTime,
    timeLabel:
      startTime && endTime
        ? `${formatTimeDisplay(startTime)} - ${formatTimeDisplay(endTime)}`
        : '',
    services: plain.services || [],
    foods: plain.foods || [],
    serviceDetails: lineText(plain.services),
    foodDetails: lineText(plain.foods),
    membershipType: plain.membershipType || '',
    membershipDiscount: Number(plain.membershipDiscount) || 0,
    cashbackTotal: Number(plain.cashbackTotal) || 0,
    subTotal: Number(plain.subTotal) || 0,
    grandTotal: Number(plain.grandTotal) || 0,
    paidAmount: Number(plain.paidAmount) || 0,
    dueAmount: Number(plain.dueAmount) || 0,
    status: plain.status || 'Draft',
    notes: plain.notes || '',
    paymentStatus: plain.paymentStatus || '',
    createdAt: plain.createdAt || null,
  };
};

const buildRecord = async body => {
  const errors = [];
  const customerName = String(body.customerName || '').trim();
  const customerPhone = last10(body.customerPhone);
  if (!customerName) errors.push('Customer name is required.');
  if (customerPhone.length !== 10) errors.push('A valid 10-digit mobile number is required.');

  const requestedStatus = String(body.status || 'Upcoming').trim();
  const status = STATUSES.has(requestedStatus) ? requestedStatus : 'Upcoming';

  let space = null;
  const spaceId = String(body.spaceId || '').trim();
  if (spaceId) {
    if (!mongoose.Types.ObjectId.isValid(spaceId)) errors.push('Selected space was not found.');
    else {
      space = await Space.findById(spaceId).lean();
      if (!space) errors.push('Selected space was not found.');
    }
  }

  const bookingDate = space ? parseDate(body.bookingDate) : null;
  const startTime = space ? String(body.startTime || '').trim() : '';
  const endTime = space ? String(body.endTime || '').trim() : '';
  const durationHours = space ? hoursBetween(startTime, endTime) : 0;
  if (space) {
    if (!bookingDate) errors.push('Booking date is required when a space is selected.');
    if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime) || durationHours <= 0) {
      errors.push('End time must be after start time.');
    }
  }

  const serviceInputs = Array.isArray(body.services) ? body.services : [];
  const foodInputs = Array.isArray(body.foods) ? body.foods : [];
  const catalogServices = serviceInputs.length
    ? await AdditionalService.find({isActive: {$ne: false}}).lean()
    : [];
  const foodIds = foodInputs
    .map(item => String(item?.foodId || item?.refId || ''))
    .filter(id => mongoose.Types.ObjectId.isValid(id));
  const foodDocs = foodIds.length
    ? await Food.find({_id: {$in: foodIds}, status: 'Active'}).lean()
    : [];
  const foodById = new Map(foodDocs.map(item => [String(item._id), item]));

  const services = [];
  for (const input of serviceInputs) {
    const qty = Math.max(0, Number(input?.qty) || 0);
    if (qty <= 0) continue;
    const ref = String(input?.refId || input?._id || '');
    const label = String(input?.label || input?.title || '').trim();
    const match = catalogServices.find(item =>
      (ref && String(item._id) === ref) ||
      (label && String(item.title || '').toLowerCase() === label.toLowerCase()),
    );
    if (!match) {
      errors.push(`Service "${label || 'item'}" is not available.`);
      continue;
    }
    services.push({
      refId: match._id,
      label: match.title,
      price: Math.max(0, Number(match.amount) || 0),
      qty,
      unit: match.unit || '',
      category: 'service',
    });
  }

  const foods = [];
  for (const input of foodInputs) {
    const qty = Math.max(0, Number(input?.qty) || 0);
    if (qty <= 0) continue;
    const ref = String(input?.foodId || input?.refId || '');
    const match = foodById.get(ref);
    if (!match) {
      errors.push('One of the selected food items is not available.');
      continue;
    }
    foods.push({
      refId: match._id,
      label: match.name,
      price: Math.max(0, Number(match.price) || 0),
      qty,
      unit: match.unit || '',
      category: 'food',
    });
  }

  if (!space && services.length === 0 && foods.length === 0) {
    errors.push('Add a space, a service, or a food item.');
  }
  if (errors.length) return {errors};

  const spaceQty = Math.max(1, Number(body.spaceQty) || 1);
  const unitPrice = space ? Math.max(0, Number(space.price) || 0) : 0;
  const spaceTotal = space ? roundMoney(unitPrice * durationHours * spaceQty) : 0;
  const servicesTotal = roundMoney(services.reduce((sum, line) => sum + line.price * line.qty, 0));
  const foodTotal = roundMoney(foods.reduce((sum, line) => sum + line.price * line.qty, 0));
  const subTotal = roundMoney(spaceTotal + servicesTotal + foodTotal);

  const customer = await findCustomer(customerPhone);
  const plan = await findPlan(customer);
  const spaceBenefit = applyBenefit(spaceTotal, benefitPercents(plan, 'Space'));
  const serviceBenefit = applyBenefit(servicesTotal, benefitPercents(plan, 'Services'));
  const foodBenefit = applyBenefit(foodTotal, benefitPercents(plan, 'Food'));
  const membershipDiscount = roundMoney(
    spaceBenefit.discount + serviceBenefit.discount + foodBenefit.discount,
  );
  const cashbackTotal = roundMoney(
    spaceBenefit.cashback + serviceBenefit.cashback + foodBenefit.cashback,
  );
  const grandTotal = roundMoney(Math.max(0, subTotal - membershipDiscount));
  const paymentStatus = ['full', 'partial', 'due'].includes(String(body.paymentStatus || '').trim())
    ? String(body.paymentStatus).trim()
    : '';
  const resolvedStatus =
    status === 'Draft' || status === 'Cancelled'
      ? status
      : computeBookingStatus(toDateKey(bookingDate), startTime, endTime, status);

  const confirmingPayment =
    Boolean(paymentStatus) && resolvedStatus !== 'Draft' && resolvedStatus !== 'Cancelled';
  let paidAmount;
  let dueAmount;
  if (confirmingPayment) {
    const tendered = Math.max(0, Number(body.paidAmount) || 0);
    const clientDue = roundMoney(Math.max(0, Number(body.dueAmount) || 0));
    const clientFinal = roundMoney(Math.max(0, Number(body.finalAmount) || 0));
    const rule = await getBookingPaymentRule();
    const coversServerTotal = tendered + 1 >= grandTotal;
    const paidCheckoutInFull =
      clientDue <= 1 && tendered > 0 && (clientFinal <= 0 || tendered + 1 >= clientFinal);
    // Full is the maximum. A checkout that already collected its whole bill
    // is not rejected by the partial minimum.
    if (paymentStatus === 'full' && (coversServerTotal || paidCheckoutInFull)) {
      paidAmount = grandTotal;
      dueAmount = 0;
    } else {
      const paymentError = bookingPaymentError({
        total: grandTotal,
        paid: tendered,
        paymentStatus,
        rule,
      });
      if (paymentError) {
        errors.push(paymentError);
        return {errors};
      }
      paidAmount = appliedBookingPayment(grandTotal, tendered);
      const gap = roundMoney(Math.max(0, grandTotal - paidAmount));
      dueAmount = paymentStatus === 'full' && gap <= 1 ? 0 : gap;
      if (dueAmount === 0) paidAmount = grandTotal;
    }
  }

  return {
    errors,
    record: {
      customerId: customer?._id || null,
      customerName: customer?.name || customerName,
      customerPhone,
      customerEmail: customer?.email || String(body.customerEmail || '').trim(),
      spaceId: space?._id || null,
      spaceName: space?.name || '',
      spaceCode: space?.spaceCode || '',
      spaceType: space?.spaceType || '',
      spaceCategory: space?.category || '',
      spaceDay: space?.day || '',
      unitPrice,
      spaceQty,
      durationHours,
      bookingDate,
      startTime,
      endTime,
      services,
      foods,
      membershipType: plan ? customer.membershipType || plan.planId || '' : '',
      membershipDiscount,
      cashbackTotal,
      subTotal,
      grandTotal,
      status: resolvedStatus,
      notes: String(body.notes || '').trim().slice(0, 200),
      ...(paymentStatus ? {paymentStatus} : {}),
      ...(confirmingPayment ? {paidAmount, dueAmount} : {}),
    },
    customer,
    blocksSpace: Boolean(space) && resolvedStatus !== 'Draft' && resolvedStatus !== 'Cancelled',
  };
};

const sendValidation = (res, error) =>
  res.status(error.status || 400).json({
    success: false,
    code: error.code,
    message: error.message,
  });

const persistBooking = async ({record, blocksSpace, excludeId, existing}) => {
  const save = async () => {
    if (existing) {
      Object.assign(existing, record);
      if (!existing.bookingCode) {
        existing.bookingCode = `AB-${String(existing._id).slice(-6).toUpperCase()}`;
      }
      await existing.save();
      return existing;
    }
    const created = await AllBooking.create(record);
    created.bookingCode = `AB-${String(created._id).slice(-6).toUpperCase()}`;
    await created.save();
    return created;
  };

  if (!blocksSpace) return save();

  const group = await resolveSpaceGroup(record.spaceId);
  if (!group) {
    const error = new Error('Selected space was not found.');
    error.status = 400;
    throw error;
  }
  const {intervals, errors} = buildBookingIntervals({
    bookingDate: toDateKey(record.bookingDate),
    startTime: record.startTime,
    endTime: record.endTime,
    dateMode: 'single',
  });
  if (errors.length) {
    const error = new Error(errors[0]);
    error.status = 400;
    throw error;
  }
  return validateAndPersistSchedule({
    group,
    intervals,
    excludeId,
    persist: save,
  });
};

export const getAllBookings = async (req, res) => {
  try {
    const status = String(req.query.status || 'All').trim();
    const includes = String(req.query.includes || 'All').trim();
    const search = String(req.query.search || '').trim().toLowerCase();
    const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(String(req.query.limit || '20'), 10) || 20));
    const fromDate = req.query.fromDate ? parseDate(req.query.fromDate) : null;
    const toDate = req.query.toDate ? parseDate(req.query.toDate) : null;
    if ((req.query.fromDate && !fromDate) || (req.query.toDate && !toDate)) {
      return res.status(400).json({success: false, message: 'Dates must be valid.'});
    }
    if (fromDate && toDate && toDate < fromDate) {
      return res.status(400).json({success: false, message: 'End date must be on or after the start date.'});
    }

    const query = {};
    if (status !== 'All' && STATUSES.has(status)) query.status = status;
    if (includes === 'Space') query.spaceId = {$ne: null};
    if (includes === 'Services') query['services.0'] = {$exists: true};
    if (includes === 'Food') query['foods.0'] = {$exists: true};
    if (fromDate || toDate) {
      query.bookingDate = {};
      if (fromDate) query.bookingDate.$gte = fromDate;
      if (toDate) {
        const end = new Date(toDate);
        end.setHours(23, 59, 59, 999);
        query.bookingDate.$lte = end;
      }
    }

    const docs = await AllBooking.find(query).sort({createdAt: -1}).lean();
    const phones = docs.map(doc => doc.customerPhone);
    const customers = await Customer.find({
      mobile: {$in: [...new Set(phones.map(last10).filter(value => value.length === 10))]},
    })
      .select('name mobile email membershipType')
      .lean();
    const byPhone = new Map(customers.map(customer => [last10(customer.mobile), customer]));
    const rows = docs
      .map(doc => serialize(doc, byPhone.get(last10(doc.customerPhone))))
      .filter(row => {
        if (!search) return true;
        return [
          row.bookingCode,
          row.customerName,
          row.customerPhone,
          row.spaceDetails,
          row.serviceDetails,
          row.foodDetails,
        ]
          .join(' ')
          .toLowerCase()
          .includes(search);
      });

    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(page, pages);
    const start = (safePage - 1) * limit;
    return res.status(200).json({
      success: true,
      bookings: rows.slice(start, start + limit),
      pagination: {page: safePage, limit, total, pages},
    });
  } catch (error) {
    console.error('getAllBookings error:', error);
    return res.status(500).json({success: false, message: 'Failed to fetch bookings.'});
  }
};

export const createAllBooking = async (req, res) => {
  try {
    const built = await buildRecord(req.body || {});
    if (built.errors.length) {
      return res.status(400).json({success: false, message: built.errors[0], errors: built.errors});
    }
    built.record.createdBy = {
      m_staff_id: req.user?.m_staff_id || null,
      m_staff_name: req.user?.name || null,
      m_staff_email: req.user?.email || null,
    };
    const saved = await persistBooking({
      record: built.record,
      blocksSpace: built.blocksSpace,
    });
    return res.status(201).json({
      success: true,
      message: 'Booking saved.',
      booking: serialize(saved, built.customer),
    });
  } catch (error) {
    if (error instanceof BookingValidationError || error.status) {
      return sendValidation(res, error);
    }
    console.error('createAllBooking error:', error);
    return res.status(500).json({success: false, message: 'Failed to save booking.'});
  }
};

export const updateAllBooking = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid booking id.'});
    }
    const existing = await AllBooking.findById(id);
    if (!existing) {
      return res.status(404).json({success: false, message: 'Booking not found.'});
    }
    const built = await buildRecord(req.body || {});
    if (built.errors.length) {
      return res.status(400).json({success: false, message: built.errors[0], errors: built.errors});
    }
    const saved = await persistBooking({
      record: built.record,
      blocksSpace: built.blocksSpace,
      excludeId: id,
      existing,
    });
    return res.status(200).json({
      success: true,
      message: 'Booking updated.',
      booking: serialize(saved, built.customer),
    });
  } catch (error) {
    if (error instanceof BookingValidationError || error.status) {
      return sendValidation(res, error);
    }
    console.error('updateAllBooking error:', error);
    return res.status(500).json({success: false, message: 'Failed to update booking.'});
  }
};

export const deleteAllBooking = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid booking id.'});
    }
    const deleted = await AllBooking.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({success: false, message: 'Booking not found.'});
    }
    return res.status(200).json({success: true, message: 'Booking deleted.'});
  } catch (error) {
    console.error('deleteAllBooking error:', error);
    return res.status(500).json({success: false, message: 'Failed to delete booking.'});
  }
};

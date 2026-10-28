export const BOOKING_MIN_PAYMENT_PERCENT = 70;

export const BOOKING_MIN_PAYMENT_MESSAGE =
  'Minimum 70% payment is required to confirm the booking.';

export const DEFAULT_BOOKING_PAYMENT_RULE = Object.freeze({
  enablePartialPayment: true,
  minimumPaymentType: 'percentage',
  minimumPaymentValue: BOOKING_MIN_PAYMENT_PERCENT,
  paymentInstructions: '',
  refundPercent: 100,
});

const roundPaise = value => Math.round((Number(value) || 0) * 100) / 100;

export const normalizeBookingPaymentRule = (input = {}) => {
  const type =
    String(input.minimumPaymentType || '').trim().toLowerCase() === 'fixed'
      ? 'fixed'
      : 'percentage';
  let value = Number(input.minimumPaymentValue);
  if (!Number.isFinite(value) || value < 0) {
    value = type === 'percentage' ? BOOKING_MIN_PAYMENT_PERCENT : 0;
  }
  if (type === 'percentage') value = Math.min(100, value);
  let refundPercent = Number(input.refundPercent);
  if (!Number.isFinite(refundPercent)) refundPercent = 100;
  refundPercent = Math.min(100, Math.max(0, refundPercent));
  const enabled =
    input.enablePartialPayment !== false && input.enablePartialPayment !== 'false';
  return {
    enablePartialPayment: enabled,
    minimumPaymentType: type,
    minimumPaymentValue: roundPaise(value),
    paymentInstructions: String(input.paymentInstructions || '').trim().slice(0, 500),
    refundPercent: roundPaise(refundPercent),
  };
};

/** Smallest amount that still covers a percentage minimum, rounded up to paise. */
export const minimumBookingPayment = (total, percent = BOOKING_MIN_PAYMENT_PERCENT) => {
  const amount = Math.max(0, Number(total) || 0);
  const rate = Math.max(0, Number(percent) || 0);
  if (amount <= 0 || rate <= 0) return 0;
  return Math.ceil((amount * rate) / 100 * 100 - 1e-8) / 100;
};

/** Minimum collected at checkout for a saved rule. Full payment is required when partial is off. */
export const minimumFromRule = (total, rule = DEFAULT_BOOKING_PAYMENT_RULE) => {
  const amount = Math.max(0, Number(total) || 0);
  const active = normalizeBookingPaymentRule(rule);
  if (amount <= 0) return 0;
  if (!active.enablePartialPayment) return amount;
  if (active.minimumPaymentType === 'fixed') {
    const fixed = Math.ceil(active.minimumPaymentValue * 100 - 1e-8) / 100;
    return Math.min(amount, Math.max(0, fixed));
  }
  return minimumBookingPayment(amount, active.minimumPaymentValue);
};

export const bookingMinimumMessage = (rule = DEFAULT_BOOKING_PAYMENT_RULE) => {
  const active = normalizeBookingPaymentRule(rule);
  if (!active.enablePartialPayment) {
    return 'Full payment is required to confirm the booking.';
  }
  if (active.minimumPaymentType === 'fixed') {
    return `Minimum payment of ₹${active.minimumPaymentValue.toLocaleString('en-IN')} is required to confirm the booking.`;
  }
  return `Minimum ${active.minimumPaymentValue}% payment is required to confirm the booking.`;
};

/** Cash tendered above the total is change, so only the covered portion counts. */
export const appliedBookingPayment = (total, paid) => {
  const amount = Math.max(0, Number(total) || 0);
  const tendered = Math.max(0, Number(paid) || 0);
  return Math.min(amount, tendered);
};

export const refundableAmount = (paid, rule = DEFAULT_BOOKING_PAYMENT_RULE) => {
  const active = normalizeBookingPaymentRule(rule);
  const collected = Math.max(0, Number(paid) || 0);
  return roundPaise((collected * active.refundPercent) / 100);
};

/**
 * Returns the booking payment message, or an empty string when the payment
 * is allowed. Without a rule, the historical 70% minimum still applies.
 */
export const bookingPaymentError = ({total, paid, paymentStatus, rule}) => {
  const amount = Math.max(0, Number(total) || 0);
  if (amount <= 0) return '';

  const active = rule ? normalizeBookingPaymentRule(rule) : DEFAULT_BOOKING_PAYMENT_RULE;
  const status = String(paymentStatus || '').trim().toLowerCase();
  const applied = appliedBookingPayment(amount, paid);
  const minimum = minimumFromRule(amount, active);
  const message = bookingMinimumMessage(active);

  // Full is the maximum. It is not limited by the partial-payment minimum.
  if (status === 'full') {
    if (amount - applied > 1) {
      return 'Full payment must cover the total booking amount.';
    }
    return '';
  }

  if (!active.enablePartialPayment) {
    return 'Full payment is required to confirm the booking.';
  }
  if (status !== 'partial') return message;
  if (applied + 0.5 < minimum) return message;
  return '';
};

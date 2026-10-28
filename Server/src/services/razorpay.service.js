import Razorpay from 'razorpay';
import crypto from 'crypto';

export const getRazorpayInstance = () => {
  const keyId = String(process.env.RAZORPAY_KEY_ID || '').trim();
  const keySecret = String(process.env.RAZORPAY_KEY_SECRET || '').trim();

  if (!keyId || !keySecret) {
    const error = new Error(
      'Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET in your .env file.',
    );
    error.status = 500;
    throw error;
  }

  return new Razorpay({ key_id: keyId, key_secret: keySecret });
};

/**
 * Create a Razorpay order.
 * amount is in rupees — we convert to paise internally.
 */
export const createRazorpayOrder = async ({ amount, currency = 'INR', receipt, notes = {} }) => {
  const instance = getRazorpayInstance();
  const amountInPaise = Math.round(Number(amount) * 100);

  if (!Number.isFinite(amountInPaise) || amountInPaise < 100) {
    const error = new Error('Amount must be at least ₹1.');
    error.status = 400;
    throw error;
  }

  const order = await instance.orders.create({
    amount: amountInPaise,
    currency,
    receipt: String(receipt || '').slice(0, 40),
    notes,
  });

  return order;
};

/**
 * Verify Razorpay payment signature.
 * Returns true if valid.
 */
export const verifyRazorpaySignature = ({ razorpayOrderId, razorpayPaymentId, razorpaySignature }) => {
  const keySecret = String(process.env.RAZORPAY_KEY_SECRET || '').trim();
  if (!keySecret) return false;

  const body = `${razorpayOrderId}|${razorpayPaymentId}`;
  const expectedSignature = crypto
    .createHmac('sha256', keySecret)
    .update(body)
    .digest('hex');

  return expectedSignature === razorpaySignature;
};

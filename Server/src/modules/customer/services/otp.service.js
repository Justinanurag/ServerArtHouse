import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import CustomerOtp from '../models/customerOtp.model.js';
import {normalizeMobile, isEmail} from '../utils/normalize.js';
import {sendWhatsAppOtp} from './whatsapp.service.js';

const OTP_LENGTH = 6;
const OTP_EXPIRY_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const SALT_ROUNDS = 10;

const createTransporter = () => {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
    port: Number(process.env.SMTP_PORT) || 587,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
};

const generateOtp = () => {
  const max = 10 ** OTP_LENGTH;
  const num = crypto.randomInt(0, max);
  return String(num).padStart(OTP_LENGTH, '0');
};

const resolveIdentifier = (raw, typeHint) => {
  if (typeHint === 'email' || isEmail(raw)) {
    return {
      identifier: String(raw).trim().toLowerCase(),
      identifierType: 'email',
    };
  }
  const mobile = normalizeMobile(raw);
  if (!mobile) return null;
  return {identifier: mobile, identifierType: 'mobile'};
};

const sendEmailOtp = async ({to, otp, purpose}) => {
  const transporter = createTransporter();
  if (!transporter) {
    console.log(`[Customer OTP][Email stub] to=${to} otp=${otp} purpose=${purpose}`);
    return {channel: 'email-stub', delivered: false};
  }

  await transporter.sendMail({
    from: `"${process.env.SENDER_NAME || 'Woo Woo Art House'}" <${
      process.env.SENDER_EMAIL || process.env.SMTP_USER
    }>`,
    to,
    subject: 'Your Woo Woo Art House OTP',
    text: `Your OTP is ${otp}. It is valid for 5 minutes.`,
    html: `<p>Your OTP is <strong>${otp}</strong>.</p><p>It is valid for 5 minutes.</p>`,
  });

  return {channel: 'email', delivered: true};
};

export const createAndSendOtp = async ({
  identifier: rawIdentifier,
  identifierType,
  purpose,
  meta = {},
}) => {
  const resolved = resolveIdentifier(rawIdentifier, identifierType);
  if (!resolved) {
    const error = new Error('Invalid mobile number or email');
    error.status = 400;
    throw error;
  }

  const recent = await CustomerOtp.findOne({
    identifier: resolved.identifier,
    purpose,
    createdAt: {$gte: new Date(Date.now() - RESEND_COOLDOWN_MS)},
  }).sort({createdAt: -1});

  if (recent && !recent.verified) {
    const waitMs = RESEND_COOLDOWN_MS - (Date.now() - recent.createdAt.getTime());
    const error = new Error(
      `Please wait ${Math.ceil(waitMs / 1000)}s before requesting another OTP`,
    );
    error.status = 429;
    error.retryAfter = Math.ceil(waitMs / 1000);
    throw error;
  }

  await CustomerOtp.deleteMany({
    identifier: resolved.identifier,
    purpose,
    verified: false,
  });

  const otp = generateOtp();
  const otpHash = await bcrypt.hash(otp, SALT_ROUNDS);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);

  await CustomerOtp.create({
    identifier: resolved.identifier,
    identifierType: resolved.identifierType,
    purpose,
    otpHash,
    maxAttempts: MAX_ATTEMPTS,
    expiresAt,
    meta,
  });

  let delivery;
  if (resolved.identifierType === 'email') {
    delivery = await sendEmailOtp({
      to: resolved.identifier,
      otp,
      purpose,
    });
  } else {
    delivery = await sendWhatsAppOtp({to: resolved.identifier, otp});
  }

  const response = {
    identifier: resolved.identifier,
    identifierType: resolved.identifierType,
    purpose,
    expiresIn: OTP_EXPIRY_MS / 1000,
    resendIn: RESEND_COOLDOWN_MS / 1000,
    delivery,
  };

  if (process.env.CUSTOMER_OTP_DEBUG === 'true') {
    response.debugOtp = otp;
  }

  return response;
};

export {sendWhatsAppOtp};

export const verifyOtpCode = async ({
  identifier: rawIdentifier,
  identifierType,
  purpose,
  otp,
}) => {
  const resolved = resolveIdentifier(rawIdentifier, identifierType);
  if (!resolved) {
    const error = new Error('Invalid mobile number or email');
    error.status = 400;
    throw error;
  }

  const record = await CustomerOtp.findOne({
    identifier: resolved.identifier,
    purpose,
    verified: false,
  }).sort({createdAt: -1});

  if (!record) {
    const error = new Error('OTP not found. Please request a new one.');
    error.status = 400;
    throw error;
  }

  if (record.expiresAt < new Date()) {
    const error = new Error('OTP has expired. Please request a new one.');
    error.status = 400;
    throw error;
  }

  if (record.attempts >= record.maxAttempts) {
    const error = new Error(
      'Maximum OTP attempts exceeded. Please request a new one.',
    );
    error.status = 429;
    throw error;
  }

  const match = await bcrypt.compare(String(otp), record.otpHash);
  record.attempts += 1;

  if (!match) {
    await record.save();
    const remaining = record.maxAttempts - record.attempts;
    const error = new Error(
      remaining > 0
        ? `Invalid OTP. ${remaining} attempt(s) remaining.`
        : 'Maximum OTP attempts exceeded. Please request a new one.',
    );
    error.status = 400;
    throw error;
  }

  record.verified = true;
  await record.save();

  return {
    identifier: resolved.identifier,
    identifierType: resolved.identifierType,
    purpose,
    meta: record.meta || {},
  };
};

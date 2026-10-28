import path from 'path';
import {fileURLToPath} from 'url';
import twilio from 'twilio';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load Server/src/.env explicitly (ESM imports run before server.js dotenv)
dotenv.config({path: path.join(__dirname, '../.env')});

let twilioClient = null;
let mailTransporter = null;

const getTwilioClient = () => {
  if (twilioClient) return twilioClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) {
    throw new Error('Twilio credentials missing (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN).');
  }
  twilioClient = twilio(sid, token);
  return twilioClient;
};

const getMailTransporter = () => {
  if (mailTransporter) return mailTransporter;

  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '').trim();
  if (!user || !pass) {
    throw new Error(
      'SMTP credentials missing (SMTP_USER / SMTP_PASS). Check Server/src/.env.',
    );
  }

  mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: false,
    auth: {user, pass},
  });

  return mailTransporter;
};

let otpStore = {};

const generateOtp = () =>
  Math.floor(100000 + Math.random() * 900000)
    .toString()
    .substring(0, 6);

const formatPhone = number => {
  number = number.toString().trim();
  if (number.startsWith('+91')) return number;
  number = number.replace(/\D/g, '');
  return `+91${number}`;
};

const sendOtpSms = async mobileNumber => {
  const formattedNumber = formatPhone(mobileNumber);
  const otp = generateOtp();
  otpStore[formattedNumber] = {otp, expiresAt: Date.now() + 5 * 60 * 1000};

  return getTwilioClient().messages.create({
    body: `Your OTP is ${otp}. Valid for 5 minutes.`,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: formattedNumber,
  });
};

const sendOtpEmail = async email => {
  const normalizedEmail = String(email).trim().toLowerCase();
  const otp = generateOtp();
  otpStore[normalizedEmail] = {otp, expiresAt: Date.now() + 5 * 60 * 1000};

  const senderEmail = String(process.env.SENDER_EMAIL || '').trim();
  const senderName = String(process.env.SENDER_NAME || 'WooWoo ERP').trim();
  if (!senderEmail) {
    throw new Error('SENDER_EMAIL is missing in Server/src/.env.');
  }

  const mailOptions = {
    from: `"${senderName}" <${senderEmail}>`,
    to: normalizedEmail,
    subject: 'Your Password Reset OTP',
    text: `Your OTP for password reset is: ${otp}. It is valid for 5 minutes.`,
    html: `<p>Your OTP for password reset is: <strong>${otp}</strong>.</p><p>It is valid for 5 minutes.</p>`,
  };

  return getMailTransporter().sendMail(mailOptions);
};

const checkOtp = (identifier, otp) => {
  const formatted = identifier.includes('@')
    ? String(identifier).trim().toLowerCase()
    : formatPhone(identifier);

  const record = otpStore[formatted];
  if (!record) return false;
  if (record.expiresAt < Date.now()) return false;
  if (record.otp !== otp) return false;

  delete otpStore[formatted];
  return true;
};

export {sendOtpSms, sendOtpEmail, checkOtp};

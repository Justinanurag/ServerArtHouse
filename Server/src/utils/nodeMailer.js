import path from 'path';
import {fileURLToPath} from 'url';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({path: path.join(__dirname, '../.env')});

let transporter = null;

const getTransporter = () => {
  if (transporter) return transporter;

  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '').trim();
  if (!user || !pass) {
    throw new Error('SMTP credentials missing (SMTP_USER / SMTP_PASS).');
  }

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp-relay.brevo.com',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {user, pass},
  });

  return transporter;
};

const sendEmail = async ({to, subject, body}) => {
  const from = String(process.env.SENDER_EMAIL || '').trim();
  if (!from) throw new Error('SENDER_EMAIL is missing.');

  return getTransporter().sendMail({
    from,
    to,
    subject,
    html: body,
  });
};

export default sendEmail;

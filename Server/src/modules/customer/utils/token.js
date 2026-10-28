import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import CustomerRefreshToken from '../models/customerRefreshToken.model.js';

const ACCESS_TOKEN_TTL = process.env.CUSTOMER_ACCESS_TOKEN_TTL || '15m';
const REFRESH_TOKEN_TTL_DAYS = Number(process.env.CUSTOMER_REFRESH_TOKEN_DAYS || 30);

const getAccessSecret = () =>
  process.env.CUSTOMER_JWT_ACCESS_SECRET ||
  process.env.JWT_SECRET ||
  'customer-access-dev-secret';

const getRefreshSecret = () =>
  process.env.CUSTOMER_JWT_REFRESH_SECRET ||
  process.env.JWT_SECRET ||
  'customer-refresh-dev-secret';

export const hashToken = token =>
  crypto.createHash('sha256').update(token).digest('hex');

export const generateAccessToken = customer => {
  return jwt.sign(
    {
      sub: customer._id.toString(),
      customerId: customer.customerId,
      mobile: customer.mobile,
      type: 'customer',
    },
    getAccessSecret(),
    {
      expiresIn: ACCESS_TOKEN_TTL,
      issuer: 'woowoo-customer',
      audience: 'customer-portal',
      algorithm: 'HS256',
    },
  );
};

export const verifyAccessToken = token =>
  jwt.verify(token, getAccessSecret(), {
    issuer: 'woowoo-customer',
    audience: 'customer-portal',
    algorithms: ['HS256'],
  });

export const createRefreshToken = async (customer, meta = {}) => {
  const raw = crypto.randomBytes(64).toString('hex');
  const tokenHash = hashToken(raw);
  const expiresAt = new Date(
    Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  );

  await CustomerRefreshToken.create({
    customer: customer._id,
    tokenHash,
    expiresAt,
    deviceInfo: meta.deviceInfo || {},
    ipAddress: meta.ipAddress || '',
  });

  return {raw, expiresAt};
};

export const rotateRefreshToken = async (rawToken, meta = {}) => {
  const tokenHash = hashToken(rawToken);
  const existing = await CustomerRefreshToken.findOne({tokenHash});

  if (!existing || existing.revokedAt || existing.expiresAt < new Date()) {
    return null;
  }

  existing.revokedAt = new Date();
  const nextRaw = crypto.randomBytes(64).toString('hex');
  const nextHash = hashToken(nextRaw);
  existing.replacedByTokenHash = nextHash;
  await existing.save();

  const expiresAt = new Date(
    Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  );

  await CustomerRefreshToken.create({
    customer: existing.customer,
    tokenHash: nextHash,
    expiresAt,
    deviceInfo: meta.deviceInfo || existing.deviceInfo || {},
    ipAddress: meta.ipAddress || existing.ipAddress || '',
  });

  return {customerId: existing.customer, raw: nextRaw, expiresAt};
};

export const revokeRefreshToken = async rawToken => {
  if (!rawToken) return;
  const tokenHash = hashToken(rawToken);
  await CustomerRefreshToken.updateOne(
    {tokenHash, revokedAt: null},
    {$set: {revokedAt: new Date()}},
  );
};

export const revokeAllCustomerRefreshTokens = async customerId => {
  await CustomerRefreshToken.updateMany(
    {customer: customerId, revokedAt: null},
    {$set: {revokedAt: new Date()}},
  );
};

export const setAuthCookies = (res, {accessToken, refreshToken}) => {
  const isProd = process.env.NODE_ENV === 'production';
  const refreshMaxAge = REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;

  res.cookie('customerAccessToken', accessToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge: 15 * 60 * 1000,
    path: '/',
  });

  res.cookie('customerRefreshToken', refreshToken, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge: refreshMaxAge,
    path: '/api/customer',
  });
};

export const clearAuthCookies = res => {
  const isProd = process.env.NODE_ENV === 'production';
  res.clearCookie('customerAccessToken', {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/',
  });
  res.clearCookie('customerRefreshToken', {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    path: '/api/customer',
  });
};

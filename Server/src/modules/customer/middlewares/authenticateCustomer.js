import Customer from '../../../models/customer.model.js';
import {verifyAccessToken} from '../utils/token.js';
import {sendError} from '../utils/response.js';

export const authenticateCustomer = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const bearer =
      authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : null;
    const token = bearer || req.cookies?.customerAccessToken;

    if (!token) {
      return sendError(res, {
        status: 401,
        message: 'Unauthorized. Access token missing.',
      });
    }

    const decoded = verifyAccessToken(token);
    if (decoded.type !== 'customer') {
      return sendError(res, {
        status: 401,
        message: 'Invalid customer token.',
      });
    }

    const customer = await Customer.findOne({
      _id: decoded.sub,
      isDeleted: {$ne: true},
    });

    if (!customer) {
      return sendError(res, {
        status: 401,
        message: 'Customer not found.',
      });
    }

    if (customer.status === 'blocked') {
      return sendError(res, {
        status: 403,
        message: 'Your account has been blocked.',
      });
    }

    req.customer = customer;
    req.customerAuth = decoded;
    return next();
  } catch (error) {
    const message =
      error.name === 'TokenExpiredError'
        ? 'Access token expired'
        : 'Invalid or expired access token';
    return sendError(res, {
      status: 401,
      message,
      errors: error.name === 'TokenExpiredError' ? {code: 'TOKEN_EXPIRED'} : null,
    });
  }
};

export const authorizeCustomer =
  (...statuses) =>
  (req, res, next) => {
    if (!req.customer) {
      return sendError(res, {status: 401, message: 'Unauthorized'});
    }
    if (statuses.length && !statuses.includes(req.customer.status)) {
      return sendError(res, {
        status: 403,
        message: 'You are not allowed to perform this action',
      });
    }
    return next();
  };

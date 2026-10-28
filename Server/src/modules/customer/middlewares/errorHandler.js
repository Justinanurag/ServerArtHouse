import {sendError} from '../utils/response.js';

export const customerErrorHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  const status = err.status || err.statusCode || 500;
  const message =
    status === 500 && process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message || 'Internal server error';

  if (status >= 500) {
    console.error('[Customer Auth Error]', err);
  }

  return sendError(res, {
    status,
    message,
    errors: err.errors || null,
  });
};

import {sendError} from '../utils/response.js';

export const validateRequest = schema => (req, res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const errors = result.error.issues.map(issue => ({
      field: issue.path.join('.') || 'body',
      message: issue.message,
    }));
    return sendError(res, {
      status: 400,
      message: errors[0]?.message || 'Validation failed',
      errors,
    });
  }
  req.body = result.data;
  return next();
};

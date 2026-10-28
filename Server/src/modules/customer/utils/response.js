export const sendSuccess = (
  res,
  {status = 200, message = 'Success', data = null, token, refreshToken} = {},
) => {
  const payload = {
    success: true,
    message,
  };

  if (data !== null && data !== undefined) {
    payload.data = data;
  }
  if (token !== undefined) {
    payload.token = token;
  }
  if (refreshToken !== undefined) {
    payload.refreshToken = refreshToken;
  }

  return res.status(status).json(payload);
};

export const sendError = (
  res,
  {status = 400, message = 'Something went wrong', errors = null} = {},
) => {
  const payload = {
    success: false,
    message,
  };

  if (errors) {
    payload.errors = errors;
  }

  return res.status(status).json(payload);
};

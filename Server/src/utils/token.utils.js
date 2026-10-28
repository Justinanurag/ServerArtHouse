import jwt from 'jsonwebtoken';

export const createTokenAndSetCookie = (res, payload) => {
  const {userId, phoneNumber} = payload;
  const token = jwt.sign({userId, phoneNumber}, process.env.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: '10d',
  });

  const isProd = process.env.NODE_ENV === 'production';

  res.cookie('authToken', token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    maxAge: 240 * 60 * 60 * 1000,
  });

  return token;
};

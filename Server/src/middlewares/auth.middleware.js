import jwt from 'jsonwebtoken';

export const authenticateUser = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const bearer =
      authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : null;
    const token = bearer || req.cookies?.authToken;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized. Token missing.',
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ['HS256'],
    });

    req.user = decoded;

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token.',
    });
  }
};

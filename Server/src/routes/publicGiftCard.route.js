import express from 'express';
import rateLimit from 'express-rate-limit';
import {getPublicGiftCard} from '../controllers/giftCard.controller.js';

// No auth: anyone holding a share link can view the card. The limiter makes
// guessing tokens impractical on top of their 192 bits of randomness.
const publicGiftCardLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {success: false, message: 'Too many requests. Please try again in a minute.'},
});

const router = express.Router();

router.get('/:token', publicGiftCardLimiter, getPublicGiftCard);

export default router;

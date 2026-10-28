import express from 'express';
import rateLimit from 'express-rate-limit';
import {registerExhibitionPasses} from '../controllers/exhibition.controller.js';
const registerLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {success: false, message: 'Too many registrations. Please try again in a few minutes.'},
});

const router = express.Router();

router.post('/passes', registerLimiter, registerExhibitionPasses);

export default router;

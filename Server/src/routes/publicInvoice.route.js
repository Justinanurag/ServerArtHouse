import express from 'express';
import rateLimit from 'express-rate-limit';
import {getPublicInvoice} from '../modules/customer/services/activity.service.js';

const publicInvoiceLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: {success: false, message: 'Too many requests. Please try again in a minute.'},
});

const router = express.Router();

router.get('/:id', publicInvoiceLimiter, async (req, res) => {
  try {
    const invoice = await getPublicInvoice(req.params.id);
    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: 'Invoice not found.',
      });
    }
    return res.status(200).json({
      success: true,
      message: 'Invoice loaded.',
      data: invoice,
    });
  } catch (error) {
    console.error('getPublicInvoice error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to load invoice.',
    });
  }
});

export default router;

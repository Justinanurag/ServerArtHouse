import express from 'express';
import {
  getAdditionalServices,
  createAdditionalService,
  updateAdditionalService,
  deleteAdditionalService,
} from '../controllers/additionalService.controller.js';

const router = express.Router();

router.get('/', getAdditionalServices);
router.post('/', createAdditionalService);
router.put('/:id', updateAdditionalService);
router.patch('/:id', updateAdditionalService);
router.delete('/:id', deleteAdditionalService);

export default router;

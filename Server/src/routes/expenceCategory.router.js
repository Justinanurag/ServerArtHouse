import express from 'express';
import {
  getAllExpenceCategory,
  addExpenceCategory,
  updateExpenceCategory,
  deleteExpenceCategory,
} from '../controllers/expenceCategory.controller.js';

const router = express.Router();


router.get('/', getAllExpenceCategory);
router.post('/', addExpenceCategory);
router.patch('/:id',updateExpenceCategory);
router.delete('/:id', deleteExpenceCategory);

export default router;
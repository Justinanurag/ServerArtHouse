import express from 'express';
import {
  addLeadTimeline,
  createLead,
  getLead,
  getLeadById,
  getLeadMembership,
  deleteLead,
  updateLead,
  uploadLeadAttachments,
} from '../controllers/lead.controller.js';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {attachStaffContext} from '../middlewares/authorize.middleware.js';

const router = express.Router();
router.use(authenticateUser, attachStaffContext);

router.get('/', getLead);
router.get('/membership', getLeadMembership);
router.get('/:id', getLeadById);
router.post('/:id/timeline', addLeadTimeline);
router.post('/', uploadLeadAttachments.array('attachments'), createLead);
router.delete('/:id', deleteLead);
router.delete('/', deleteLead);
router.patch('/:id', uploadLeadAttachments.array('attachments'), updateLead);
router.patch('/', uploadLeadAttachments.array('attachments'), updateLead);

export default router;
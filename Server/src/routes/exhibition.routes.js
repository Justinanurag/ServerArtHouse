import express from 'express';
import {authenticateUser} from '../middlewares/auth.middleware.js';
import {attachStaffContext, requirePermission} from '../middlewares/authorize.middleware.js';
import {PERMISSIONS} from '../constants/permissions.js';
import {
    createExhibition,
    getExhibitions,
    getExhibitionById,
    updateExhibition,
    deleteExhibition,
    markExhibitionAttendance,
    checkInExhibitionPass,
} from '../controllers/exhibition.controller.js';

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

router.post('/', requirePermission(PERMISSIONS.EXHIBITION_CREATE), createExhibition);
router.get('/:id', requirePermission(PERMISSIONS.EXHIBITION_READ), getExhibitionById);
router.get('/', requirePermission(PERMISSIONS.EXHIBITION_READ), getExhibitions);
router.patch(
    '/:id/attendance',
    requirePermission(PERMISSIONS.EXHIBITION_UPDATE),
    markExhibitionAttendance,
);
router.patch('/:id', requirePermission(PERMISSIONS.EXHIBITION_UPDATE), updateExhibition);
router.delete('/:id', requirePermission(PERMISSIONS.EXHIBITION_DELETE), deleteExhibition);
router.post('/check-in', requirePermission(PERMISSIONS.EXHIBITION_UPDATE), checkInExhibitionPass);

export default router;
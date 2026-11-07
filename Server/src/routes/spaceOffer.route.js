import express from "express";
import {authenticateUser} from "../middlewares/auth.middleware.js";
import {
  attachStaffContext,
  requireAnyPermission,
  requirePermission,
} from "../middlewares/authorize.middleware.js";
import {PERMISSIONS} from "../constants/permissions.js";
import {
  createSpaceOffer,
  deleteSpaceOffer,
  getApplicableSpaceOffer,
  getSpaceOfferById,
  getSpaceOffers,
  setSpaceOfferStatus,
  updateSpaceOffer,
} from "../controllers/spaceOffer.controller.js";

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

router.post("/", requirePermission(PERMISSIONS.COUPON_MANAGE), createSpaceOffer);
router.get("/", requirePermission(PERMISSIONS.COUPON_READ), getSpaceOffers);
router.post(
  "/applicable",
  requireAnyPermission(
    PERMISSIONS.COUPON_READ,
    PERMISSIONS.SPACE_BOOKING_CREATE,
    PERMISSIONS.SPACE_BOOKING_UPDATE,
  ),
  getApplicableSpaceOffer,
);
router.get(
  "/applicable",
  requireAnyPermission(
    PERMISSIONS.COUPON_READ,
    PERMISSIONS.SPACE_BOOKING_CREATE,
    PERMISSIONS.SPACE_BOOKING_UPDATE,
  ),
  getApplicableSpaceOffer,
);
router.get("/:id", requirePermission(PERMISSIONS.COUPON_READ), getSpaceOfferById);
router.patch("/:id", requirePermission(PERMISSIONS.COUPON_MANAGE), updateSpaceOffer);
router.patch("/:id/status", requirePermission(PERMISSIONS.COUPON_MANAGE), setSpaceOfferStatus);
router.delete("/:id", requirePermission(PERMISSIONS.COUPON_MANAGE), deleteSpaceOffer);

export default router;

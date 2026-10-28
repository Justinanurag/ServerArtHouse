import express from "express";
import {authenticateUser} from "../middlewares/auth.middleware.js";
import {
  attachStaffContext,
  requireAnyPermission,
} from "../middlewares/authorize.middleware.js";
import {PERMISSIONS} from "../constants/permissions.js";
import {
  enrollCsp,
  getCSP,
  getCspPartnerDetails,
  updateCsp,
} from "../controllers/csp.controller.js";
import {
  listCspApplications,
  reviewCspApplication,
} from "../controllers/cspApplication.controller.js";

const router = express.Router();

router.use(authenticateUser, attachStaffContext);

router.get(
  "/",
  requireAnyPermission(PERMISSIONS.CSP_READ, PERMISSIONS.CUSTOMER_READ),
  getCSP,
);
router.post(
  "/enroll",
  requireAnyPermission(PERMISSIONS.CSP_WRITE, PERMISSIONS.CUSTOMER_CREATE),
  enrollCsp,
);
router.post(
  "/",
  requireAnyPermission(PERMISSIONS.CSP_WRITE, PERMISSIONS.CUSTOMER_CREATE),
  enrollCsp,
);
router.get(
  "/applications",
  requireAnyPermission(PERMISSIONS.CSP_READ, PERMISSIONS.CUSTOMER_READ),
  listCspApplications,
);
router.patch(
  "/applications/:id",
  requireAnyPermission(PERMISSIONS.CSP_WRITE, PERMISSIONS.CUSTOMER_UPDATE),
  reviewCspApplication,
);
router.get(
  "/:id/details",
  requireAnyPermission(PERMISSIONS.CSP_READ, PERMISSIONS.CUSTOMER_READ),
  getCspPartnerDetails,
);
router.patch(
  "/:id",
  requireAnyPermission(PERMISSIONS.CSP_WRITE, PERMISSIONS.CUSTOMER_UPDATE),
  updateCsp,
);


// router.get("/enroll",getEnrollment);
export default router;

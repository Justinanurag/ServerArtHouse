import {getMembershipOrderAmount as getDbMembershipOrderAmount} from '../../../services/membershipPlan.service.js';

/**
 * Membership plan prices are loaded from the shared Membership collection.
 */
export const getMembershipOrderAmount = planId => getDbMembershipOrderAmount(planId);

/** @deprecated use getMembershipOrderAmount(planId) */
export const MEMBERSHIP_PLAN_PRICES = {};

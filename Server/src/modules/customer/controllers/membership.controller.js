import {
  getActiveCustomerMembershipPlans,
} from '../../../services/membershipPlan.service.js';

export const getCustomerMembershipPlans = async (_req, res) => {
  try {
    const plans = await getActiveCustomerMembershipPlans();
    return res.status(200).json({
      success: true,
      message: 'Membership plans fetched successfully.',
      data: plans,
    });
  } catch (error) {
    console.error('getCustomerMembershipPlans error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch membership plans.',
    });
  }
};

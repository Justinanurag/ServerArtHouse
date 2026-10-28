import { asyncHandler } from '../utils/asyncHandler.js';
import { sendSuccess } from '../utils/response.js';
import * as activityService from '../services/activity.service.js';

export const getActivity=asyncHandler(async(req,res)=>{
    const data = await activityService.getCustomerActivity(req.customer._id, {
    page: req.query.page,
    limit: req.query.limit,
    status: req.query.status, // Paid | Pending | Cancelled (optional)
  });
  return sendSuccess(res, {
    message: 'Activity loaded',
    data,
  });
});
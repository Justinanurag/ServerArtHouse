import {asyncHandler} from '../utils/asyncHandler.js';
import {sendError, sendSuccess} from '../utils/response.js';
import * as activityService from '../services/activity.service.js';

export const getMyActivity = asyncHandler(async (req, res) => {
  const data = await activityService.getCustomerActivity(req.customer._id, {
    page: req.query.page,
    limit: req.query.limit,
    status: req.query.status,
    customerMobile: req.customer.mobile,
  });

  return sendSuccess(res, {
    message: 'Activity loaded',
    data,
  });
});

export const getMyActivityDetail = asyncHandler(async (req, res) => {
  const detail = await activityService.getCustomerActivityDetail(
    req.customer._id,
    req.params.invoiceId,
    {customerMobile: req.customer.mobile},
  );

  if (!detail) {
    return sendError(res, {
      status: 404,
      message: 'Invoice not found.',
    });
  }

  return sendSuccess(res, {
    message: 'Invoice loaded',
    data: detail,
  });
});


export const getMyActivityInsights=asyncHandler(async(req,res)=>{
  const data = await activityService.getCustomerActivityInsights(req.customer._id, {
   customerMobile: req.customer.mobile
  });
  return sendSuccess(res, {
    message: 'Activity Insights loaded',
    data,
  });
})

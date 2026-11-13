import {
  getInsights,
  getVisitorPage,
  getVisitHistory,
} from '../services/insightsAnalytics.service.js';

const fail = (res, error, message) => {
  console.error(message, error);
  return res.status(500).json({success: false, message});
};

export const insightsOverview = async (req, res) => {
  try {
    const data = await getInsights(req.query);
    if (data?.error) return res.status(400).json({success: false, message: data.error});
    return res.status(200).json(data);
  } catch (error) {
    return fail(res, error, 'Could not load insights.');
  }
};

export const insightsVisitors = async (req, res) => {
  try {
    const data = await getVisitorPage(req.query);
    if (data?.error) return res.status(400).json({success: false, message: data.error});
    return res.status(200).json(data);
  } catch (error) {
    return fail(res, error, 'Could not load visitors.');
  }
};

export const insightsVisitHistory = async (req, res) => {
  try {
    const data = await getVisitHistory(req.params.customerKey, req.query);
    if (data?.error) return res.status(400).json({success: false, message: data.error});
    return res.status(200).json(data);
  } catch (error) {
    return fail(res, error, 'Could not load this customer.');
  }
};

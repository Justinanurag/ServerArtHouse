import mongoose from 'mongoose';
import HapApplication from '../models/hapApplication.model.js';
import Customer from '../models/customer.model.js';
import {sendError, sendSuccess} from '../modules/customer/utils/response.js';

export const HAP_PROFESSIONS = [
  'Student',
  'Working Professional',
  'Business Owner',
  'Freelancer',
  'Content Creator',
  'Influencer',
  'Artist',
  'Homemaker',
  'Other',
];

const STATUSES = ['under_review', 'approved', 'rejected'];

const toDto = doc => {
  const plain = doc?.toObject ? doc.toObject() : doc;
  const customer =
    plain?.customerId && typeof plain.customerId === 'object'
      ? plain.customerId
      : null;
  return {
    _id: plain._id,
    customerId: customer?._id || plain.customerId || null,
    customerName: String(customer?.name || '').trim(),
    email: String(customer?.email || '').trim(),
    mobile: String(customer?.mobile || '').trim(),
    profession: plain.profession || '',
    networkSize: Number(plain.networkSize) || 0,
    payoutDetail: plain.payoutDetail || '',
    presence: plain.presence || '',
    status: plain.status || 'under_review',
    rejectionReason: plain.rejectionReason || '',
    reviewedAt: plain.reviewedAt || null,
    createdAt: plain.createdAt || null,
    updatedAt: plain.updatedAt || null,
  };
};

const readFields = body => {
  const profession = String(body?.profession || '').trim();
  const networkSize = Number(body?.networkSize);
  const payoutDetail = String(
    body?.payoutDetail || body?.upiOrAccount || '',
  ).trim();
  const presence = String(
    body?.presence || body?.websiteOrSocial || '',
  ).trim();

  if (!HAP_PROFESSIONS.includes(profession)) {
    return {error: 'Select a profession.'};
  }
  if (!Number.isInteger(networkSize) || networkSize < 1 || networkSize > 10000000) {
    return {error: 'Network size must be a whole number of at least 1.'};
  }
  if (payoutDetail.length < 4 || payoutDetail.length > 100) {
    return {error: 'Enter a UPI ID or account number.'};
  }
  if (presence.length < 3 || presence.length > 200) {
    return {error: 'Enter a website or social media profile.'};
  }

  return {
    value: {profession, networkSize, payoutDetail, presence},
  };
};

const populateCustomer = query =>
  query.populate('customerId', 'name mobile email');

export const applyHap = async (req, res) => {
  try {
    const customer = req.customer;
    const requestedId = String(req.body?.customerId || '').trim();
    if (requestedId && requestedId !== String(customer._id)) {
      return sendError(res, {
        status: 403,
        message: 'You can only apply with your own customer id.',
      });
    }

    const parsed = readFields(req.body || {});
    if (parsed.error) {
      return sendError(res, {status: 400, message: parsed.error});
    }

    const openApplication = await HapApplication.findOne({
      customerId: customer._id,
      status: {$in: ['under_review', 'approved']},
    }).sort({createdAt: -1});

    if (openApplication?.status === 'approved') {
      return sendError(res, {
        status: 409,
        message: 'Your HAP application is already approved.',
      });
    }
    if (openApplication?.status === 'under_review') {
      return sendError(res, {
        status: 409,
        message: 'Your HAP application is already under review.',
      });
    }

    const application = await HapApplication.create({
      customerId: customer._id,
      ...parsed.value,
      status: 'under_review',
    });
    const populated = await populateCustomer(
      HapApplication.findById(application._id),
    );

    return sendSuccess(res, {
      status: 201,
      message: 'HAP application submitted. Please wait for approval.',
      data: toDto(populated),
    });
  } catch (error) {
    console.error('applyHap error:', error);
    return sendError(res, {
      status: 500,
      message: error.message || 'Failed to submit HAP application.',
    });
  }
};

export const getMyHapApplication = async (req, res) => {
  try {
    const application = await populateCustomer(
      HapApplication.findOne({customerId: req.customer._id}).sort({
        createdAt: -1,
      }),
    );
    return sendSuccess(res, {
      message: application
        ? 'HAP application fetched.'
        : 'No HAP application yet.',
      data: application ? toDto(application) : null,
    });
  } catch (error) {
    console.error('getMyHapApplication error:', error);
    return sendError(res, {
      status: 500,
      message: 'Failed to fetch HAP application.',
    });
  }
};

export const updateMyHapApplication = async (req, res) => {
  try {
    const application = await HapApplication.findOne({
      customerId: req.customer._id,
      status: 'under_review',
    }).sort({createdAt: -1});
    if (!application) {
      return sendError(res, {
        status: 404,
        message: 'No HAP application under review to update.',
      });
    }
    const parsed = readFields(req.body || {});
    if (parsed.error) {
      return sendError(res, {status: 400, message: parsed.error});
    }
    Object.assign(application, parsed.value);
    await application.save();
    const populated = await populateCustomer(
      HapApplication.findById(application._id),
    );
    return sendSuccess(res, {
      message: 'HAP application updated.',
      data: toDto(populated),
    });
  } catch (error) {
    console.error('updateMyHapApplication error:', error);
    return sendError(res, {
      status: 500,
      message: 'Failed to update HAP application.',
    });
  }
};

export const deleteMyHapApplication = async (req, res) => {
  try {
    const application = await HapApplication.findOne({
      customerId: req.customer._id,
      status: {$in: ['under_review', 'rejected']},
    }).sort({createdAt: -1});
    if (!application) {
      return sendError(res, {
        status: 404,
        message: 'No HAP application can be withdrawn.',
      });
    }
    await application.deleteOne();
    return sendSuccess(res, {
      message: 'HAP application withdrawn.',
      data: {_id: application._id},
    });
  } catch (error) {
    console.error('deleteMyHapApplication error:', error);
    return sendError(res, {
      status: 500,
      message: 'Failed to withdraw HAP application.',
    });
  }
};

export const listHapApplications = async (req, res) => {
  try {
    const status = String(req.query.status || '')
      .trim()
      .toLowerCase();
    const query = {};
    if (STATUSES.includes(status)) query.status = status;
    const rows = await populateCustomer(
      HapApplication.find(query).sort({createdAt: -1}),
    );
    return res.status(200).json({
      success: true,
      message: 'HAP applications fetched.',
      applications: rows.map(toDto),
    });
  } catch (error) {
    console.error('listHapApplications error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch HAP applications.',
    });
  }
};

export const getHapApplication = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid application id.'});
    }
    const application = await populateCustomer(HapApplication.findById(id));
    if (!application) {
      return res.status(404).json({
        success: false,
        message: 'HAP application not found.',
      });
    }
    return res.status(200).json({
      success: true,
      message: 'HAP application fetched.',
      application: toDto(application),
    });
  } catch (error) {
    console.error('getHapApplication error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch HAP application.',
    });
  }
};

export const createHapApplication = async (req, res) => {
  try {
    const customerId = String(req.body?.customerId || '').trim();
    if (!mongoose.Types.ObjectId.isValid(customerId)) {
      return res.status(400).json({
        success: false,
        message: 'A valid customer is required.',
      });
    }
    const customer = await Customer.findOne({
      _id: customerId,
      isDeleted: {$ne: true},
    });
    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found.',
      });
    }
    const parsed = readFields(req.body || {});
    if (parsed.error) {
      return res.status(400).json({success: false, message: parsed.error});
    }
    const openApplication = await HapApplication.findOne({
      customerId,
      status: {$in: ['under_review', 'approved']},
    });
    if (openApplication) {
      return res.status(409).json({
        success: false,
        message: 'This customer already has an open HAP application.',
      });
    }
    const application = await HapApplication.create({
      customerId,
      ...parsed.value,
      status: 'under_review',
    });
    const populated = await populateCustomer(
      HapApplication.findById(application._id),
    );
    return res.status(201).json({
      success: true,
      message: 'HAP application created.',
      application: toDto(populated),
    });
  } catch (error) {
    console.error('createHapApplication error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create HAP application.',
    });
  }
};

export const updateHapApplication = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid application id.'});
    }
    const application = await HapApplication.findById(id);
    if (!application) {
      return res.status(404).json({
        success: false,
        message: 'HAP application not found.',
      });
    }

    const next = String(req.body?.status || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_');

    if (next === 'approved' || next === 'rejected') {
      if (application.status !== 'under_review') {
        return res.status(400).json({
          success: false,
          message: 'Only an application under review can be approved or rejected.',
        });
      }
      if (next === 'rejected') {
        const reason = String(
          req.body?.rejectionReason || req.body?.reason || '',
        ).trim();
        if (!reason) {
          return res.status(400).json({
            success: false,
            message: 'A rejection reason is required.',
          });
        }
        application.status = 'rejected';
        application.rejectionReason = reason;
      } else {
        application.status = 'approved';
        application.rejectionReason = '';
      }
      application.reviewedAt = new Date();
      await application.save();
    } else {
      const parsed = readFields({
        profession: req.body?.profession ?? application.profession,
        networkSize: req.body?.networkSize ?? application.networkSize,
        payoutDetail: req.body?.payoutDetail ?? application.payoutDetail,
        presence: req.body?.presence ?? application.presence,
      });
      if (parsed.error) {
        return res.status(400).json({success: false, message: parsed.error});
      }
      Object.assign(application, parsed.value);
      await application.save();
    }

    const populated = await populateCustomer(
      HapApplication.findById(application._id),
    );
    return res.status(200).json({
      success: true,
      message:
        next === 'approved'
          ? 'Application approved.'
          : next === 'rejected'
            ? 'Application rejected.'
            : 'HAP application updated.',
      application: toDto(populated),
    });
  } catch (error) {
    console.error('updateHapApplication error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to update HAP application.',
    });
  }
};

export const deleteHapApplication = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid application id.'});
    }
    const application = await HapApplication.findByIdAndDelete(id);
    if (!application) {
      return res.status(404).json({
        success: false,
        message: 'HAP application not found.',
      });
    }
    return res.status(200).json({
      success: true,
      message: 'HAP application deleted.',
      application: {_id: application._id},
    });
  } catch (error) {
    console.error('deleteHapApplication error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete HAP application.',
    });
  }
};

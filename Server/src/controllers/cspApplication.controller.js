import mongoose from 'mongoose';
import CspApplication from '../models/cspApplication.model.js';
import Customer from '../models/customer.model.js';
import {
  activateEnrollmentForCustomer,
  applicationForActiveEnrollment,
} from './csp.controller.js';
import {sendError, sendSuccess} from '../modules/customer/utils/response.js';

const PROSITE_PATTERN = /^(?:https?:\/\/)?(?:www\.)?1atives\.com\/pro\/[a-z0-9][a-z0-9_-]*\/?$/i;

export const normalizePrositeUrl = raw => {
  const value = String(raw || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '');
  if (!PROSITE_PATTERN.test(`https://${value}`) && !PROSITE_PATTERN.test(value)) {
    return null;
  }
  return value.toLowerCase();
};

const toApplicationDto = doc => {
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
    brandName: plain.brandName || '',
    categories: Array.isArray(plain.categories) ? plain.categories : [],
    prositeUrl: plain.prositeUrl || '',
    alreadySelling: Boolean(plain.alreadySelling),
    sellingPlatforms: Array.isArray(plain.sellingPlatforms)
      ? plain.sellingPlatforms
      : [],
    status: plain.status || 'under_review',
    rejectionReason: plain.rejectionReason || '',
    reviewedAt: plain.reviewedAt || null,
    enrollmentId: plain.enrollmentId || null,
    createdAt: plain.createdAt || null,
    updatedAt: plain.updatedAt || null,
  };
};

const readApplicationBody = body => {
  const brandName = String(body?.brandName || '').trim();
  const categories = Array.isArray(body?.categories)
    ? body.categories.map(item => String(item || '').trim()).filter(Boolean)
    : [];
  const prositeUrl = normalizePrositeUrl(body?.prositeUrl);
  const alreadySelling =
    body?.alreadySelling === true ||
    String(body?.alreadySelling || '').toLowerCase() === 'yes';
  const sellingPlatforms = Array.isArray(body?.sellingPlatforms)
    ? body.sellingPlatforms.map(item => String(item || '').trim()).filter(Boolean)
    : [];

  if (!brandName) {
    return {error: 'Brand name is required.'};
  }
  if (!categories.length) {
    return {error: 'Select at least one category.'};
  }
  if (!prositeUrl) {
    return {
      error: 'Prosite URL must look like 1atives.com/pro/your-name.',
    };
  }
  if (alreadySelling && !sellingPlatforms.length) {
    return {error: 'Select where you are currently selling.'};
  }

  return {
    value: {
      brandName,
      categories,
      prositeUrl,
      alreadySelling,
      sellingPlatforms: alreadySelling ? sellingPlatforms : [],
    },
  };
};

export const applyCsp = async (req, res) => {
  try {
    const customer = req.customer;
    const requestedId = String(req.body?.customerId || '').trim();
    if (requestedId && requestedId !== String(customer._id)) {
      return sendError(res, {
        status: 403,
        message: 'You can only apply with your own customer id.',
      });
    }

    const parsed = readApplicationBody(req.body || {});
    if (parsed.error) {
      return sendError(res, {status: 400, message: parsed.error});
    }

    const openApplication = await CspApplication.findOne({
      customerId: customer._id,
      status: {$in: ['under_review', 'approved']},
    }).sort({createdAt: -1});

    if (openApplication?.status === 'approved') {
      return sendError(res, {
        status: 409,
        message: 'Your CSP application is already approved.',
      });
    }
    if (openApplication?.status === 'under_review') {
      return sendError(res, {
        status: 409,
        message: 'Your CSP application is already under review.',
      });
    }

    const application = await CspApplication.create({
      customerId: customer._id,
      ...parsed.value,
      status: 'under_review',
    });

    const populated = await CspApplication.findById(application._id).populate(
      'customerId',
      'name mobile email',
    );

    return sendSuccess(res, {
      status: 201,
      message: 'CSP application submitted. Status is under review.',
      data: toApplicationDto(populated),
    });
  } catch (error) {
    console.error('applyCsp error:', error);
    return sendError(res, {
      status: 500,
      message: error.message || 'Failed to submit CSP application.',
    });
  }
};

export const getMyCspApplication = async (req, res) => {
  try {
    const enrolled = await applicationForActiveEnrollment(req.customer);
    const application = enrolled
      ? await CspApplication.findById(enrolled._id).populate(
          'customerId',
          'name mobile email',
        )
      : await CspApplication.findOne({
          customerId: req.customer._id,
        })
          .sort({createdAt: -1})
          .populate('customerId', 'name mobile email');

    return sendSuccess(res, {
      message: application
        ? 'CSP application fetched.'
        : 'No CSP application yet.',
      data: application ? toApplicationDto(application) : null,
    });
  } catch (error) {
    console.error('getMyCspApplication error:', error);
    return sendError(res, {
      status: 500,
      message: 'Failed to fetch CSP application.',
    });
  }
};

export const listCspApplications = async (req, res) => {
  try {
    const status = String(req.query.status || 'under_review')
      .trim()
      .toLowerCase();
      console.log(status);
    const query = {};
    if (['under_review', 'approved', 'rejected'].includes(status)) {
      query.status = status;
    }

    const rows = await CspApplication.find(query)
      .sort({createdAt: -1})
      .populate('customerId', 'name mobile email');

    return res.status(200).json({
      success: true,
      message: 'CSP applications fetched.',
      applications: rows.map(toApplicationDto),
    });
  } catch (error) {
    console.error('listCspApplications error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch CSP applications.',
    });
  }
};

export const reviewCspApplication = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid application id.',
      });
    }

    const application = await CspApplication.findById(id);
    if (!application) {
      return res.status(404).json({
        success: false,
        message: 'CSP application not found.',
      });
    }
    if (application.status !== 'under_review') {
      return res.status(400).json({
        success: false,
        message: 'Only an application under review can be approved or rejected.',
      });
    }

    const next = String(req.body?.status || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_');
    if (!['approved', 'rejected'].includes(next)) {
      return res.status(400).json({
        success: false,
        message: 'status must be approved or rejected.',
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
      application.reviewedAt = new Date();
      await application.save();
    } else {
      const customer = await Customer.findOne({
        _id: application.customerId,
        isDeleted: {$ne: true},
      });
      if (!customer) {
        return res.status(404).json({
          success: false,
          message: 'Customer for this application was not found.',
        });
      }
      const enrollment = await activateEnrollmentForCustomer(customer, {
        brandName: application.brandName,
        companyName: application.brandName,
        prositeUrl: application.prositeUrl,
      });
      application.status = 'approved';
      application.rejectionReason = '';
      application.reviewedAt = new Date();
      application.enrollmentId = enrollment._id;
      await application.save();
    }

    const populated = await CspApplication.findById(application._id).populate(
      'customerId',
      'name mobile email',
    );

    return res.status(200).json({
      success: true,
      message:
        next === 'approved'
          ? 'Application approved. The CSP program is now available to this customer.'
          : 'Application rejected.',
      application: toApplicationDto(populated),
    });
  } catch (error) {
    console.error('reviewCspApplication error:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to review CSP application.',
    });
  }
};

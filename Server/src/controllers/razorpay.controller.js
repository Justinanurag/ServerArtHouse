import mongoose from 'mongoose';
import Customer from '../models/customer.model.js';
import Membership from '../models/membership.model.js';
import {createRazorpayOrder, verifyRazorpaySignature} from '../services/razorpay.service.js';
import {createSubscription} from './subscription.controller.js';

/**
 * POST /customer/:customerId/membership/razorpay-order
 *
 * Body: { planId }   — membership planId (e.g. "premium")
 *
 * Creates a Razorpay order for the membership plan and returns:
 *   { orderId, amount, currency, keyId, planId, plan }
 */
export const createMembershipOrder = async (req, res) => {
  try {
    const {customerId} = req.params;

    if (!mongoose.Types.ObjectId.isValid(customerId)) {
      return res.status(400).json({success: false, message: 'Invalid customer id.'});
    }

    const customer = await Customer.findById(customerId)
      .select('name mobile email whatsappNumber membershipType')
      .lean();
    if (!customer) {
      return res.status(404).json({success: false, message: 'Customer not found.'});
    }

    const planId = String(req.body?.planId || '').trim().toLowerCase();
    if (!planId) {
      return res.status(400).json({success: false, message: 'planId is required.'});
    }

    const plan = await Membership.findOne({planId, status: 'Active'}).lean();
    if (!plan) {
      return res.status(404).json({success: false, message: `No active membership plan found for planId "${planId}".`});
    }

    const amount = Math.max(0, Number(plan.pricing?.amount ?? 0));
    if (amount <= 0) {
      return res.status(400).json({success: false, message: 'This membership plan has no payable amount.'});
    }

    const receipt = `mbr_${String(customer.mobile || customerId).slice(-10)}_${Date.now().toString(36)}`.slice(0, 40);

    const order = await createRazorpayOrder({
      amount,
      currency: 'INR',
      receipt,
      notes: {
        customerId: String(customerId),
        customerName: String(customer.name || ''),
        customerPhone: String(customer.mobile || ''),
        planId,
        planName: String(plan.displayName || planId),
      },
    });

    return res.status(200).json({
      success: true,
      orderId: order.id,
      amount: order.amount,       // paise
      amountInRupees: amount,
      currency: order.currency,
      keyId: String(process.env.RAZORPAY_KEY_ID || '').trim(),
      planId,
      plan: {
        _id: plan._id,
        planId: plan.planId,
        displayName: plan.displayName,
        pricing: plan.pricing,
        pricing_period: plan.pricing?.period,
      },
      customer: {
        name: customer.name,
        mobile: customer.mobile,
        email: customer.email,
      },
    });
  } catch (error) {
    console.error('createMembershipOrder error:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to create Razorpay order.',
    });
  }
};

/**
 * POST /customer/:customerId/membership/razorpay-verify
 *
 * Body:
 *   razorpayOrderId, razorpayPaymentId, razorpaySignature  — from Razorpay checkout callback
 *   planId                                                  — membership plan
 *   startDate, endDate                                      — membership validity dates
 *   notes                                                   — optional
 *
 * Verifies the payment signature, then calls createSubscription internally.
 */
export const verifyMembershipPayment = async (req, res) => {
  try {
    const {customerId} = req.params;

    if (!mongoose.Types.ObjectId.isValid(customerId)) {
      return res.status(400).json({success: false, message: 'Invalid customer id.'});
    }

    const {
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
      planId,
      startDate,
      endDate,
      notes: extraNotes,
    } = req.body;

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return res.status(400).json({
        success: false,
        message: 'razorpayOrderId, razorpayPaymentId, and razorpaySignature are required.',
      });
    }

    const isValid = verifyRazorpaySignature({
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
    });

    if (!isValid) {
      return res.status(400).json({
        success: false,
        message: 'Payment verification failed. Invalid signature.',
      });
    }

    const customer = await Customer.findById(customerId)
      .select('name mobile email')
      .lean();
    if (!customer) {
      return res.status(404).json({success: false, message: 'Customer not found.'});
    }

    const normalizedPlanId = String(planId || '').trim().toLowerCase();
    const plan = await Membership.findOne({planId: normalizedPlanId, status: 'Active'}).lean();
    if (!plan) {
      return res.status(404).json({success: false, message: `No active membership plan found for planId "${normalizedPlanId}".`});
    }

    const amount = Math.max(0, Number(plan.pricing?.amount ?? 0));
    const period = String(plan.pricing?.period || 'Monthly').trim().toLowerCase();

    // Compute start/end dates if not supplied
    const resolvedStart = startDate ? new Date(startDate) : new Date();
    let resolvedEnd;
    if (endDate) {
      resolvedEnd = new Date(endDate);
    } else {
      resolvedEnd = new Date(resolvedStart);
      if (period.includes('year')) {
        resolvedEnd.setFullYear(resolvedEnd.getFullYear() + 1);
      } else if (period.includes('lifetime')) {
        resolvedEnd.setFullYear(resolvedEnd.getFullYear() + 100);
      } else {
        // Default: 1 month
        resolvedEnd.setMonth(resolvedEnd.getMonth() + 1);
      }
    }

    const repeatType = period.includes('year') ? 'yearly' : period.includes('lifetime') ? 'lifetime' : 'monthly';
    const repeatEvery = 1;

    // Delegate to the existing createSubscription controller via a synthetic req/res
    const subscriptionBody = {
      customerName: String(customer.name || ''),
      customerPhone: String(customer.mobile || ''),
      membershipType: normalizedPlanId,
      membershipId: String(plan._id),
      membershipPlanId: String(plan._id),
      invoiceDate: resolvedStart.toISOString(),
      startDate: resolvedStart.toISOString(),
      endDate: resolvedEnd.toISOString(),
      dueDate: resolvedEnd.toISOString(),
      repeatType,
      repeatEvery,
      status: 'active',
      paymentMode: 'Razorpay',
      subTotal: amount,
      grandTotal: amount,
      items: [
        {
          productName: String(plan.displayName || plan.planId),
          qty: 1,
          unitPrice: amount,
          discount: 0,
          lineTotal: amount,
          category: 'membership',
        },
      ],
      notes: [
        `Razorpay Order: ${razorpayOrderId}`,
        `Razorpay Payment: ${razorpayPaymentId}`,
        extraNotes || '',
      ]
        .filter(Boolean)
        .join(' | '),
      createdBy: {
        m_staff_id: req.user?.userId ?? null,
        m_staff_name: req.user?.name ?? null,
        m_staff_email: req.user?.email ?? null,
      },
    };

    // Use a fake res to capture createSubscription's response
    let subscriptionResult = null;
    let subscriptionError = null;
    const fakeRes = {
      status(code) {
        this._status = code;
        return this;
      },
      json(body) {
        if (this._status >= 400) {
          subscriptionError = body;
        } else {
          subscriptionResult = body;
        }
        return this;
      },
      _status: 200,
    };

    const fakeReq = {
      ...req,
      body: subscriptionBody,
    };

    await createSubscription(fakeReq, fakeRes);

    if (subscriptionError) {
      return res.status(fakeRes._status || 400).json({
        success: false,
        message: subscriptionError.message || 'Subscription creation failed after payment.',
        details: subscriptionError,
      });
    }

    return res.status(201).json({
      success: true,
      message: 'Payment verified and membership activated successfully.',
      razorpayOrderId,
      razorpayPaymentId,
      subscription: subscriptionResult?.subscription,
    });
  } catch (error) {
    console.error('verifyMembershipPayment error:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Failed to verify payment.',
    });
  }
};

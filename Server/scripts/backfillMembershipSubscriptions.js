/**
 * Create Subscription rows for customers who have membershipType set
 * but never got a Subscription document (legacy customer-portal activations).
 *
 * Usage (from Server folder):
 *   node scripts/backfillMembershipSubscriptions.js
 *   node scripts/backfillMembershipSubscriptions.js --phone=9122072324
 */
import path from 'path';
import {fileURLToPath} from 'url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Customer from '../src/models/customer.model.js';
import Subscription from '../src/models/subscription.model.js';
import {
  backfillMissingMembershipSubscriptions,
  ensureSubscriptionForMembership,
} from '../src/services/subscriptionFromMembership.service.js';
import Membership from '../src/models/membership.model.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({path: path.join(__dirname, '../src/.env')});

const phoneArg = process.argv.find(a => a.startsWith('--phone='));
const targetPhone = phoneArg ? phoneArg.split('=')[1].replace(/\D/g, '') : '';

const run = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('❌ MONGODB_URI missing in Server/src/.env');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('✅ Connected');

  if (targetPhone) {
    const ten = targetPhone.slice(-10);
    const variants = [...new Set([targetPhone, ten, `+91${ten}`, `91${ten}`, `0${ten}`])];
    const customer = await Customer.findOne({
      isDeleted: {$ne: true},
      mobile: {$in: variants},
    }).lean();

    if (!customer) {
      console.error('❌ No customer found for phone', targetPhone);
      process.exit(1);
    }

    console.log('Customer:', {
      name: customer.name,
      mobile: customer.mobile,
      membershipType: customer.membershipType,
      membershipPlanId: customer.membershipPlanId,
    });

    const existing = await Subscription.find({
      customerPhone: {$in: variants},
    })
      .select('subscriptionCode membershipType status customerPhone customerName createdAt')
      .lean();
    console.log('Existing subscriptions:', existing.length, existing);

    if (!existing.length && customer.membershipType && customer.membershipType !== 'none') {
      const plan = customer.membershipPlanId
        ? await Membership.findById(customer.membershipPlanId).lean()
        : await Membership.findOne({
            planId: String(customer.membershipType).toLowerCase(),
          }).lean();

      const sub = await ensureSubscriptionForMembership({
        customer,
        membershipType: customer.membershipType,
        membershipPlan: plan,
        orderAmount: customer.membershipPurchase?.orderAmount,
        discountAmount: customer.membershipPurchase?.discountAmount,
        paidAmount: customer.membershipPurchase?.paidAmount,
        couponCode: customer.membershipPurchase?.couponCode,
        paymentOrder: customer.membershipPurchase?.paymentOrderId
          ? {
              _id: customer.membershipPurchase.paymentOrderId,
              txnid: customer.membershipPurchase.txnid,
            }
          : null,
        createdBy: {
          m_staff_id: null,
          m_staff_name: 'System backfill',
          m_staff_email: null,
        },
      });
      console.log('✅ Created subscription:', sub?.subscriptionCode, sub?.membershipType);
    } else if (existing.length) {
      console.log('ℹ️ Subscription already exists — nothing to create');
    } else {
      console.log('⚠️ Customer has no membershipType — cannot create subscription');
    }
  } else {
    const result = await backfillMissingMembershipSubscriptions({limit: 500});
    console.log('Backfill result:', result);
  }

  await mongoose.disconnect();
  process.exit(0);
};

run().catch(err => {
  console.error(err);
  process.exit(1);
});

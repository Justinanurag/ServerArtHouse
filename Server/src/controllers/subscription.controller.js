import mongoose from 'mongoose';
import Counter from '../models/counter.model.js';
import Subscription from '../models/subscription.model.js';
import Customer from '../models/customer.model.js';
import Membership from '../models/membership.model.js';
import Wallet from '../models/wallet.model.js';
import {sendSubscriptionCreatedEmail} from '../utils/brevoMailer.js';
import {
  validateSubscriptionCreateBody,
  validateSubscriptionUpdateBody,
} from '../schemas/subscription.schema.js';
import {validateReferralDiscountForOrder} from './affiliate.controller.js';
import {validateCouponForOrder} from './coupon.controller.js';
import {creditReferralDiscountToInviter, markReferralDiscountUsed} from '../modules/customer/services/referral.service.js';
import {sendNewMembershipWhatsApp, sendMembershipRenewalWhatsApp, sendMembershipChangeWhatsApp} from '../modules/customer/services/whatsapp.service.js';
import {resolvePlanMeta} from '../services/membershipPlan.service.js';
import {
  appendTransaction,
  debitWalletForPurchase,
  getSpendableWalletBalance,
} from './wallet.controller.js';
import Invoice from '../models/invoice.model.js';
import WhatsAppReminderLog from '../models/whatsappReminderLog.model.js';

/** Credit fixed plan wallet cashback when membership is purchased (idempotent). */
export const creditPlanPurchaseCashback = async ({
  customer,
  subscriptionCode,
  amount,
  planName,
  createdBy,
}) => {
  const cashbackAmt = Math.max(0, Number(amount ?? 0));
  if (!customer?._id || !(cashbackAmt > 0)) return null;

  let wallet = await Wallet.findOne({customerId: customer._id});
  if (!wallet) {
    wallet = await Wallet.create({
      customerId: customer._id,
      customerName: String(customer.name ?? '').trim(),
      customerPhone: String(customer.mobile ?? '').trim(),
      // Seed from customer so signup/welcome balance is not wiped
      walletAmount: Math.max(0, Number(customer.walletAmount ?? 0) || 0),
      cashbackBalance: Math.max(0, Number(customer.cashbackBalance ?? 0) || 0),
      affiliateBalance: Math.max(0, Number(customer.affiliateBalance ?? 0) || 0),
      transactions: [],
    });
  }

  const ref = String(subscriptionCode || '').trim();
  const alreadyCredited = (wallet.transactions || []).some(
    tx =>
      String(tx.referenceId || '').trim() === ref &&
      String(tx.type || '').toLowerCase() === 'credit' &&
      String(tx.referenceType || '') === 'MembershipPurchase' &&
      /cashback/i.test(String(tx.note || '')),
  );
  if (alreadyCredited) return wallet;

  return appendTransaction(wallet, {
    type: 'credit',
    amount: cashbackAmt,
    note: `Membership purchase cashback · ${planName || 'Plan'} · ${ref}`,
    referenceType: 'MembershipPurchase',
    referenceId: ref,
    walletType: 'nonWithdrawable',
    createdBy,
  });
};

const getNextSubscriptionNumber = async () => {
  const counter = await Counter.findOneAndUpdate(
    {key: 'subscription_number'},
    {$inc: {value: 1}},
    {new: true, upsert: true, setDefaultsOnInsert: true},
  );
  return counter.value;
};

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Throttle portal→subscription repair so list endpoints stay fast. */
let lastMembershipSubBackfillAt = 0;
const MEMBERSHIP_SUB_BACKFILL_TTL_MS = 5 * 60 * 1000;
const isJuniorMembership = value => {
  const v = String(value ?? '').trim().toLowerCase();
  return v.includes('junior') || v.includes('junoir');
};

/** Resolve plan priority from payload or Membership catalogue. */
const resolveMembershipPriority = async ({
  membershipId,
  membershipPlanId,
  membershipType,
  priorityFromBody,
}) => {
  const fromBody = Number(priorityFromBody);
  if (Number.isFinite(fromBody) && fromBody >= 0) return fromBody;

  const query = {};
  if (membershipId && mongoose.Types.ObjectId.isValid(String(membershipId))) {
    query._id = membershipId;
  } else if (membershipPlanId) {
    query.planId = String(membershipPlanId).trim().toLowerCase();
  } else if (membershipType) {
    query.planId = String(membershipType).trim().toLowerCase();
  }
  if (!Object.keys(query).length) return 0;

  const plan = await Membership.findOne(query).select('priority').lean();
  return Math.max(0, Number(plan?.priority ?? 0) || 0);
};

/**
 * Customer's effective priority for upgrade rules.
 * Junior membership priority does not restrict upgrades (treated as 0).
 */
const getCustomerUpgradePriority = async customerPhone => {
  const customer = await Customer.findOne({
    mobile: String(customerPhone || '').trim(),
    isDeleted: {$ne: true},
  })
    .select('priority membershipType membershipPlanId')
    .lean();

  if (!customer) return 0;
  if (isJuniorMembership(customer.membershipType)) return 0;

  const stored = Number(customer.priority ?? 0);
  if (Number.isFinite(stored) && stored > 0) return stored;

  if (customer.membershipPlanId) {
    const plan = await Membership.findById(customer.membershipPlanId)
      .select('priority')
      .lean();
    return Math.max(0, Number(plan?.priority ?? 0) || 0);
  }

  const type = String(customer.membershipType || '').trim().toLowerCase();
  if (type && type !== 'none') {
    const plan = await Membership.findOne({planId: type}).select('priority').lean();
    return Math.max(0, Number(plan?.priority ?? 0) || 0);
  }

  return 0;
};

/** Human-readable validity for WhatsApp `newmembership` {{3}}. */
const formatSubscriptionValidity = ({startDate, endDate, repeatUnit, repeatType}) => {
  const unit = String(repeatUnit || '').trim().toLowerCase();
  const type = String(repeatType || '').trim().toLowerCase();
  if (unit === 'year' || type === 'yearly') return '1 year';
  if (unit === 'month' || type === 'monthly') return '1 month';
  if (type === 'weekly') return '1 week';

  const start = startDate ? new Date(startDate) : null;
  const end = endDate ? new Date(endDate) : null;
  if (
    start &&
    end &&
    !Number.isNaN(start.getTime()) &&
    !Number.isNaN(end.getTime()) &&
    end > start
  ) {
    const days = Math.round((end.getTime() - start.getTime()) / 86400000);
    if (days >= 360) return '1 year';
    if (days >= 28 && days <= 31) return '1 month';
    if (days > 0) return `${days} days`;
  }

  return '1 year';
};

export const createSubscription = async (req, res) => {
  try {
    const parsed = validateSubscriptionCreateBody(req.body);
    if (!parsed.ok) {
      return res.status(400).json({
        success: false,
        message: parsed.errors.join(' '),
        errors: parsed.errors,
      });
    }

    const nextNumber = await getNextSubscriptionNumber();
    const subscriptionPrefix = 'SUB';
    const subscriptionCode = `${subscriptionPrefix}-${nextNumber}`;

    const staffFromReq = {
      m_staff_id: req.user?.userId ?? null,
      m_staff_name: req.user?.name ?? null,
      m_staff_email: req.user?.email ?? null,
    };

    const createdBy = parsed.data.createdBy ?? staffFromReq;
    const membershipType = String(parsed.data.membershipType ?? '').trim().toLowerCase();
    const juniorMembership = isJuniorMembership(membershipType);

    const newPriority = await resolveMembershipPriority({
      membershipId: parsed.data.membershipId,
      membershipPlanId: parsed.data.membershipPlanId,
      membershipType,
      priorityFromBody: parsed.data.priority,
    });

    // Junior: always allowed (priority rules do not apply).
    // Same priority renews the current plan. A lower priority is a downgrade and stays blocked.
    // Bulk historical import skips this gate (allowPastEndDate flag).
    let priorCustomerPriority = 0;
    try {
      priorCustomerPriority = await getCustomerUpgradePriority(
        parsed.data.customerPhone,
      );
    } catch {
      priorCustomerPriority = 0;
    }

    if (!juniorMembership && !req.body?.allowPastEndDate) {
      if (priorCustomerPriority > 0 && newPriority < priorCustomerPriority) {
        return res.status(409).json({
          success: false,
          message:
            'Membership downgrade not allowed. Renew the same plan, or choose a higher priority than the customer\'s current membership. Junior membership is always allowed.',
        });
      }
    }

    // Upgrade = a higher-priority plan than the one the customer already has.
    // Renewing the same priority is a new membership, not a plan change.
    const isMembershipUpgrade =
      !juniorMembership &&
      priorCustomerPriority > 0 &&
      newPriority > priorCustomerPriority &&
      !req.body?.allowPastEndDate;

    let referralDiscount = 0;
    let appliedReferral = null;
    const referral = parsed.data.referral;
    if (referral?.code || Number(referral?.discountAmount) > 0) {
      const referralValidation = await validateReferralDiscountForOrder({
        customerPhone: parsed.data.customerPhone,
        referralCode: referral?.code,
        orderAmount: parsed.data.subTotal,
        items: (parsed.data.items || []).map(item => ({
          productName: item.productName,
          qty: item.qty,
          unitPrice: item.unitPrice,
          discount: item.discount,
          lineTotal: item.lineTotal,
          category: item.category || 'membership',
        })),
      });
      if (!referralValidation.ok) {
        const softSkip =
          /no referral discount applies|no enabled commission rules|no commission rules/i.test(
            String(referralValidation.message || ''),
          );
        if (!softSkip) {
          return res.status(400).json({
            success: false,
            message: referralValidation.message,
          });
        }
      } else {
        appliedReferral = referralValidation;
        referralDiscount = Number(referralValidation.discountAmount ?? 0);
      }
    }

    let couponDiscount = 0;
    let appliedCoupon = null;
    const coupon = parsed.data.coupon;
    if (coupon?.code) {
      const couponValidation = await validateCouponForOrder({
        code: coupon.code,
        orderAmount: Math.max(0, parsed.data.subTotal - referralDiscount),
        customerPhone: parsed.data.customerPhone,
        applicableContext: 'membership',
      });
      if (!couponValidation.ok) {
        return res.status(400).json({
          success: false,
          message: couponValidation.message,
        });
      }
      appliedCoupon = couponValidation.coupon;
      couponDiscount = Number(couponValidation.discountAmount ?? 0);
    }

    const itemDiscountTotal = (parsed.data.items || []).reduce(
      (sum, item) => sum + Number(item.discount ?? 0),
      0,
    );
    const computedDiscountTotal = itemDiscountTotal + couponDiscount + referralDiscount;
    const computedGrandTotal = Math.max(0, Number(parsed.data.subTotal) - computedDiscountTotal);

    const subscription = await Subscription.create({
      subscriptionPrefix,
      subscriptionNumber: nextNumber,
      subscriptionCode,
      customerName: parsed.data.customerName,
      customerPhone: parsed.data.customerPhone,
      membershipId: parsed.data.membershipId,
      membershipPlanId: parsed.data.membershipPlanId,
      membershipType: membershipType || 'general',
      priority: newPriority,
      invoiceDate: parsed.data.invoiceDate,
      dueDate: parsed.data.dueDate,
      startDate: parsed.data.startDate,
      endDate: parsed.data.endDate,
      repeatType: parsed.data.repeatType,
      repeatEvery: parsed.data.repeatEvery,
      repeatUnit: parsed.data.repeatUnit,
      salesPersonName: parsed.data.salesPersonName,
      notes: parsed.data.notes,
      status: parsed.data.status,
      items: parsed.data.items.map(item => ({
        productName: item.productName,
        qty: item.qty,
        unitPrice: item.unitPrice,
        discount: item.discount,
        lineTotal: item.lineTotal,
      })),
      students: parsed.data.students,
      subTotal: parsed.data.subTotal,
      discountTotal: computedDiscountTotal,
      grandTotal: computedGrandTotal,
      referral: appliedReferral
        ? {
            code: appliedReferral.referralCode,
            inviterName: appliedReferral.inviterName || '',
            label: appliedReferral.label || 'Membership Referral Discount',
            discountAmount: referralDiscount,
          }
        : undefined,
      coupon: appliedCoupon
        ? {
            code: appliedCoupon.code,
            title: appliedCoupon.title,
            discountAmount: couponDiscount,
          }
        : undefined,
      mode: parsed.data.mode,
      paymentStatus: parsed.data.paymentStatus,
      paymentBreakdown: parsed.data.paymentBreakdown,
      createdBy,
      noOfInvoices: 0,
      nextInvoiceDate: parsed.data.startDate,
    });

    if (appliedReferral) {
      const commissionAmount = Number(
        appliedReferral.commissionAmount ?? referralDiscount ?? 0,
      );
      try {
        const buyer = await Customer.findOne({
          mobile: parsed.data.customerPhone,
          isDeleted: {$ne: true},
        })
          .select('_id name')
          .lean();

        if (commissionAmount > 0) {
          await creditReferralDiscountToInviter({
            inviterId: appliedReferral.inviterId,
            referredCustomerId: appliedReferral.buyerId || buyer?._id,
            sourceType: 'subscription',
            sourceId: subscriptionCode,
            orderAmount: parsed.data.subTotal,
            commissionAmount,
            commissionType: appliedReferral.discountType,
            commissionValue: appliedReferral.discountValue,
            category: appliedReferral.segments?.[0]?.category || 'membership',
            segments: appliedReferral.segments,
            buyerName: buyer?.name || parsed.data.customerName,
          });
        }

        if (referralDiscount > 0 && (appliedReferral.buyerId || buyer?._id)) {
          await markReferralDiscountUsed({
            customerId: appliedReferral.buyerId || buyer._id,
            sourceId: subscriptionCode,
          });
        }
      } catch (creditError) {
        console.error(
          'createSubscription referral commission credit error:',
          creditError,
        );
      }
    }

    const customerForMembership = await Customer.findOne({
      mobile: parsed.data.customerPhone,
      isDeleted: {$ne: true},
    })
      .select('_id membershipType priority membershipPlanId')
      .lean();

    if (juniorMembership) {
      // Junior does not overwrite a higher / non-Junior membership on the customer.
      const existingType = String(customerForMembership?.membershipType || 'none')
        .trim()
        .toLowerCase();
      const hasMainMembership =
        existingType &&
        existingType !== 'none' &&
        !isJuniorMembership(existingType);
      if (!hasMainMembership) {
        await Customer.findOneAndUpdate(
          {mobile: parsed.data.customerPhone},
          {
            $set: {
              membershipType: 'junior',
              priority: newPriority,
              ...(parsed.data.membershipId &&
              mongoose.Types.ObjectId.isValid(parsed.data.membershipId)
                ? {membershipPlanId: parsed.data.membershipId}
                : {}),
            },
          },
        );
      }
    } else {
      await Customer.findOneAndUpdate(
        {mobile: parsed.data.customerPhone},
        {
          $set: {
            membershipType: membershipType || 'general',
            priority: newPriority,
            ...(parsed.data.membershipId &&
            mongoose.Types.ObjectId.isValid(parsed.data.membershipId)
              ? {membershipPlanId: parsed.data.membershipId}
              : {}),
          },
        },
      );
    }

    try {
      const customer = await Customer.findOne({
        mobile: parsed.data.customerPhone,
      })
        .select('name email whatsappNumber mobile')
        .lean();
      const customerEmail = String(customer?.email ?? '').trim().toLowerCase();

      if (customerEmail && EMAIL_RE.test(customerEmail)) {
        await sendSubscriptionCreatedEmail({
          toEmail: customerEmail,
          customerName: customer?.name || parsed.data.customerName,
          subscriptionCode,
          subscription,
        });
      } else {
        console.warn(
          `createSubscription: email not sent for ${subscriptionCode} (missing/invalid customer email).`,
        );
      }
    } catch (mailError) {
      console.error('createSubscription email error:', mailError);
    }

    // Credit plan wallet cashback + WhatsApp on activation
    try {
      const statusNorm = String(parsed.data.status || '').trim().toLowerCase();
      if (statusNorm === 'active' || statusNorm === 'completed') {
        let membershipLabel =
          String(parsed.data.items?.[0]?.productName || '').trim() ||
          String(parsed.data.membershipType || 'Membership').trim();
        let validity = formatSubscriptionValidity({
          startDate: parsed.data.startDate,
          endDate: parsed.data.endDate,
          repeatUnit: parsed.data.repeatUnit,
          repeatType: parsed.data.repeatType,
        });
        let planWalletCashback = 0;

        try {
          const planQuery = {};
          if (parsed.data.membershipId) {
            planQuery._id = parsed.data.membershipId;
          } else if (parsed.data.membershipPlanId) {
            planQuery.planId = String(parsed.data.membershipPlanId)
              .trim()
              .toLowerCase();
          }
          if (Object.keys(planQuery).length) {
            const plan = await Membership.findOne(planQuery).lean();
            if (plan) {
              const meta = resolvePlanMeta(plan);
              membershipLabel = meta.label || membershipLabel;
              validity = meta.validity || validity;
              planWalletCashback = Math.max(
                0,
                Number(plan?.walletCashback?.amount ?? 0) || 0,
              );
            }
          }
          // Fallback: resolve by membership type / planId slug when ids were missing
          if (!(planWalletCashback > 0)) {
            const typeKey = String(
              parsed.data.membershipType ||
                parsed.data.membershipPlanId ||
                '',
            )
              .trim()
              .toLowerCase();
            if (typeKey && typeKey !== 'none' && typeKey !== 'general') {
              const escaped = typeKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const planByType = await Membership.findOne({
                $or: [
                  {planId: typeKey},
                  {planId: new RegExp(`^${escaped}$`, 'i')},
                ],
              }).lean();
              if (planByType) {
                const meta = resolvePlanMeta(planByType);
                membershipLabel = meta.label || membershipLabel;
                validity = meta.validity || validity;
                planWalletCashback = Math.max(
                  0,
                  Number(planByType?.walletCashback?.amount ?? 0) || 0,
                );
              }
            }
          }
        } catch (planError) {
          console.warn(
            'createSubscription: membership plan lookup failed:',
            planError?.message || planError,
          );
        }

        const envCashback = Number(
          process.env.WHATSAPP_MEMBERSHIP_CASHBACK ||
            process.env.MEMBERSHIP_WELCOME_CASHBACK ||
            0,
        );
        // Prefer plan wallet cashback; fall back to env welcome cashback for WhatsApp/credit
        const safeCashback =
          planWalletCashback > 0
            ? planWalletCashback
            : Number.isFinite(envCashback) && envCashback > 0
              ? envCashback
              : 0;

        const customer = await Customer.findOne({
          mobile: parsed.data.customerPhone,
        })
          .select('_id name whatsappNumber mobile')
          .lean();

        if (safeCashback > 0 && customer) {
          try {
            await creditPlanPurchaseCashback({
              customer,
              subscriptionCode,
              amount: safeCashback,
              planName: membershipLabel,
              createdBy: parsed.data.createdBy,
            });
          } catch (walletError) {
            console.error(
              'createSubscription wallet cashback error:',
              walletError?.message || walletError,
            );
          }
        }

        const whatsappTo =
          String(customer?.whatsappNumber || '').trim() ||
          String(customer?.mobile || parsed.data.customerPhone).trim();

        if (whatsappTo) {
          void (async () => {
            try {
              if (isMembershipUpgrade) {
                await sendMembershipChangeWhatsApp({
                  to: whatsappTo,
                  customerName:
                    customer?.name || parsed.data.customerName || 'Member',
                  membershipName: membershipLabel,
                  validity,
                  cashbackAmount: String(safeCashback),
                });
              } else {
                await sendNewMembershipWhatsApp({
                  to: whatsappTo,
                  name: customer?.name || parsed.data.customerName || 'Member',
                  membershipLabel,
                  validity,
                  cashbackLabel: String(safeCashback),
                });
              }
            } catch (waError) {
              console.error(
                isMembershipUpgrade
                  ? '[MembershipChange] WhatsApp send error:'
                  : '[NewMembership] WhatsApp send error:',
                waError?.message || waError,
              );
            }
          })();
        }
      }
    } catch (waSetupError) {
      console.error(
        'createSubscription WhatsApp setup error:',
        waSetupError?.message || waSetupError,
      );
    }

    return res.status(201).json({
      success: true,
      message: 'Subscription created successfully.',
      subscription,
    });
  } catch (error) {
    console.error('createSubscription error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to create subscription.',
    });
  }
};

// export const getSubscriptions = async (req, res) => {
//   try {
//     // Repair legacy portal activations that updated Customer but never created Subscription
//     const now = Date.now();
//     if (now - lastMembershipSubBackfillAt > MEMBERSHIP_SUB_BACKFILL_TTL_MS) {
//       lastMembershipSubBackfillAt = now;
//       try {
//         const {backfillMissingMembershipSubscriptions} = await import(
//           '../services/subscriptionFromMembership.service.js'
//         );
//         await backfillMissingMembershipSubscriptions({limit: 300});
//       } catch (syncErr) {
//         console.warn(
//           '[getSubscriptions] membership→subscription backfill skipped:',
//           syncErr?.message || syncErr,
//         );
//       }
//     }

//     const search = String(req.query.search ?? '').trim();
//     // Admin subscription table needs the full list; allow up to 10k (was capped at 200).
//     const limit = Math.min(Math.max(Number(req.query.limit) || 2000, 1), 10000);
//     const page = Math.max(Number(req.query.page) || 1, 1);
//     const skip = (page - 1) * limit;
//     const status = String(req.query.status ?? '').trim().toLowerCase();

//     const query = {};
//     if (status && status !== 'all') query.status = status;

//     if (search) {
//       const regex = new RegExp(escapeRegex(search), 'i');
//       query.$or = [
//         {subscriptionCode: regex},
//         {customerName: regex},
//         {customerPhone: regex},
//       ];
//     }

//     const [subscriptions, total] = await Promise.all([
//       Subscription.find(query)
//         .sort({createdAt: -1})
//         .skip(skip)
//         .limit(limit)
//         .lean(),
//       Subscription.countDocuments(query),
//     ]);

//     return res.status(200).json({
//       success: true,
//       message: 'Subscriptions fetched successfully.',
//       subscriptions,
//       total,
//       page,
//       limit,
//       hasMore: skip + subscriptions.length < total,
//     });
//   } catch (error) {
//     console.error('getSubscriptions error:', error);
//     return res.status(500).json({
//       success: false,
//       message: 'Failed to fetch subscriptions.',
//     });
//   }
// };


export const getSubscriptions = async (req, res) => {
  try {
    const search = String(req.query.search ?? '').trim();
    const fromDate = String(req.query.fromDate ?? '').trim();
    const toDate = String(req.query.toDate ?? '').trim();
    const query = {};
    const dateFilter = {};

    const limit = Math.min(Math.max(Number(req.query.limit) || 2000, 1), 5000);

    if (fromDate) {
      const from = new Date(`${fromDate}T00:00:00.000`);
      if (!Number.isNaN(from.getTime())) dateFilter.$gte = from;
    }
    if (toDate) {
      const to = new Date(`${toDate}T23:59:59.999`);
      if (!Number.isNaN(to.getTime())) dateFilter.$lte = to;
    }
    if (Object.keys(dateFilter).length) {
      query.invoiceDate = dateFilter;
    }

    if (search) {
      const regex = new RegExp(
        String(search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        'i',
      );
      query.$or = [
        {subscriptionCode: regex},
        {customerName: regex},
        {customerPhone: regex},
        {membershipType: regex},
        {status: regex},
      ];
    }

    // Newest first so dashboard / list show recent subscriptions on top
    const subscriptions = await Subscription.find(query)
      .sort({createdAt: -1, subscriptionNumber: -1, _id: -1})
      .limit(limit)
      .lean();

    return res.status(200).json({
      success: true,
      message: 'Subscriptions fetched successfully.',
      subscriptions,
    });
  } catch (error) {
    console.error('getSubscriptions error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch subscriptions.',
    });
  }
};
export const getSubscriptionById = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid id.'});
    }

    const subscription = await Subscription.findById(id).lean();
    if (!subscription) {
      return res.status(404).json({success: false, message: 'Subscription not found.'});
    }

    return res.status(200).json({
      success: true,
      message: 'Subscription fetched successfully.',
      subscription,
    });
  } catch (error) {
    console.error('getSubscriptionById error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch subscription.',
    });
  }
};

export const updateSubscription = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid id.'});
    }

    const parsed = validateSubscriptionUpdateBody(req.body);
    if (!parsed.ok) {
      return res.status(400).json({
        success: false,
        message: parsed.errors.join(' '),
        errors: parsed.errors,
      });
    }

    let shouldNotifyMembershipChange = false;
    let upgradeNotifyContext = null;

    if (parsed.data.customerPhone || parsed.data.membershipType || parsed.data.endDate || parsed.data.priority !== undefined) {
      const existing = await Subscription.findById(id).lean();
      if (!existing) {
        return res.status(404).json({success: false, message: 'Subscription not found.'});
      }

      const nextCustomerPhone = parsed.data.customerPhone ?? existing.customerPhone;
      const nextMembershipType = String(
        parsed.data.membershipType ?? existing.membershipType ?? 'general',
      ).toLowerCase();
      const juniorMembership = isJuniorMembership(nextMembershipType);

      const changingPlan =
        String(parsed.data.membershipId ?? existing.membershipId) !==
          String(existing.membershipId) ||
        String(parsed.data.membershipPlanId ?? existing.membershipPlanId) !==
          String(existing.membershipPlanId) ||
        nextMembershipType !== String(existing.membershipType || '').toLowerCase();

      if (!juniorMembership) {
        const newPriority = await resolveMembershipPriority({
          membershipId: parsed.data.membershipId ?? existing.membershipId,
          membershipPlanId:
            parsed.data.membershipPlanId ?? existing.membershipPlanId,
          membershipType: nextMembershipType,
          priorityFromBody:
            parsed.data.priority !== undefined
              ? parsed.data.priority
              : existing.priority,
        });
        const currentPriority = await getCustomerUpgradePriority(nextCustomerPhone);
        // Allow keeping same plan on edit; block only when changing to lower/equal priority from a different plan
        const existingPriority = Math.max(0, Number(existing.priority ?? 0) || 0);

        if (
          changingPlan &&
          currentPriority > 0 &&
          newPriority <= currentPriority &&
          newPriority !== existingPriority
        ) {
          return res.status(409).json({
            success: false,
            message:
              'Membership upgrade not allowed. New plan priority must be higher than the customer\'s current membership priority.',
          });
        }
      }

      if (changingPlan && !juniorMembership) {
        shouldNotifyMembershipChange = true;
        upgradeNotifyContext = {
          phone: nextCustomerPhone,
          membershipType: nextMembershipType,
          membershipId: parsed.data.membershipId ?? existing.membershipId,
          membershipPlanId:
            parsed.data.membershipPlanId ?? existing.membershipPlanId,
          startDate: parsed.data.startDate ?? existing.startDate,
          endDate: parsed.data.endDate ?? existing.endDate,
          customerName: parsed.data.customerName ?? existing.customerName,
        };
      }
    }

    if (parsed.data.paymentBreakdown) {
      const current = await Subscription.findById(id).lean();
      if (!current) {
        return res.status(404).json({success: false, message: 'Subscription not found.'});
      }
      const previousWallet = Math.max(
        0,
        Number(current.paymentBreakdown?.wallet) || 0,
      );
      const nextWallet = Math.max(
        0,
        Number(parsed.data.paymentBreakdown.wallet) || 0,
      );
      const walletDelta = Math.round((nextWallet - previousWallet) * 100) / 100;
      if (walletDelta > 0) {
        const customer = await Customer.findOne({
          mobile: String(current.customerPhone || '').trim(),
          isDeleted: {$ne: true},
        });
        if (!customer) {
          return res.status(400).json({
            success: false,
            message: 'Customer not found for wallet payment.',
          });
        }
        let wallet = await Wallet.findOne({customerId: customer._id});
        if (!wallet) {
          wallet = await Wallet.create({
            customerId: customer._id,
            customerName: String(customer.name ?? '').trim(),
            customerPhone: String(customer.mobile ?? '').trim(),
            walletAmount: Math.max(0, Number(customer.walletAmount ?? 0) || 0),
            cashbackBalance: Math.max(0, Number(customer.cashbackBalance ?? 0) || 0),
            affiliateBalance: Math.max(0, Number(customer.affiliateBalance ?? 0) || 0),
            transactions: [],
          });
        }
        const available = getSpendableWalletBalance(wallet, customer);
        if (walletDelta > available + 0.01) {
          return res.status(400).json({
            success: false,
            message: `Insufficient wallet balance. Available: ₹${Number(available).toFixed(2)}`,
          });
        }
        await debitWalletForPurchase(wallet, {
          amount: walletDelta,
          note: `Wallet used for subscription ${current.subscriptionCode || id}`,
          referenceType: 'subscription',
          referenceId: String(current.subscriptionCode || id),
          createdBy: {
            m_staff_id: req.user?.userId ?? null,
            m_staff_name: req.user?.name ?? null,
            m_staff_email: req.user?.email ?? null,
          },
        });
      }
    }

    const subscription = await Subscription.findByIdAndUpdate(
      id,
      {$set: parsed.data},
      {new: true},
    );

    if (!subscription) {
      return res.status(404).json({success: false, message: 'Subscription not found.'});
    }

    if (parsed.data.customerPhone || parsed.data.membershipType || parsed.data.priority !== undefined) {
      const membershipType = String(
        parsed.data.membershipType ?? subscription.membershipType ?? 'general',
      )
        .trim()
        .toLowerCase();
      const juniorMembership = isJuniorMembership(membershipType);
      const priority = Math.max(
        0,
        Number(
          parsed.data.priority ??
            subscription.priority ??
            0,
        ) || 0,
      );

      if (juniorMembership) {
        const customer = await Customer.findOne({
          mobile: parsed.data.customerPhone ?? subscription.customerPhone,
        })
          .select('membershipType')
          .lean();
        const existingType = String(customer?.membershipType || 'none').toLowerCase();
        const hasMain =
          existingType &&
          existingType !== 'none' &&
          !isJuniorMembership(existingType);
        if (!hasMain) {
          await Customer.findOneAndUpdate(
            {mobile: parsed.data.customerPhone ?? subscription.customerPhone},
            {$set: {membershipType: 'junior', priority}},
          );
        }
      } else {
        await Customer.findOneAndUpdate(
          {mobile: parsed.data.customerPhone ?? subscription.customerPhone},
          {
            $set: {
              membershipType,
              priority,
              ...(subscription.membershipId &&
              mongoose.Types.ObjectId.isValid(subscription.membershipId)
                ? {membershipPlanId: subscription.membershipId}
                : {}),
            },
          },
        );
      }
    }

    // After successful upgrade edit — notify via membershipchange WhatsApp
    if (shouldNotifyMembershipChange && upgradeNotifyContext) {
      void (async () => {
        try {
          const phone = String(upgradeNotifyContext.phone || '').trim();
          const customer = await Customer.findOne({
            mobile: phone,
            isDeleted: {$ne: true},
          })
            .select('name mobile whatsappNumber')
            .lean();
          const whatsappTo =
            String(customer?.whatsappNumber || '').trim() ||
            String(customer?.mobile || phone).trim();
          if (!whatsappTo) return;

          let membershipLabel = String(
            upgradeNotifyContext.membershipType || 'Membership',
          );
          let validity = formatSubscriptionValidity({
            startDate: upgradeNotifyContext.startDate,
            endDate: upgradeNotifyContext.endDate,
          });
          let cashbackAmount = 0;
          try {
            const plan = upgradeNotifyContext.membershipId
              ? await Membership.findById(upgradeNotifyContext.membershipId).lean()
              : await Membership.findOne({
                  planId: String(upgradeNotifyContext.membershipType || '').toLowerCase(),
                }).lean();
            if (plan) {
              const meta = resolvePlanMeta(plan);
              membershipLabel = meta.label || membershipLabel;
              validity = meta.validity || validity;
              cashbackAmount = Math.max(
                0,
                Number(plan?.walletCashback?.amount ?? 0) || 0,
              );
            }
          } catch {
            /* keep defaults */
          }

          await sendMembershipChangeWhatsApp({
            to: whatsappTo,
            customerName:
              customer?.name || upgradeNotifyContext.customerName || 'Member',
            membershipName: membershipLabel,
            validity,
            cashbackAmount: String(cashbackAmount),
          });
        } catch (waError) {
          console.error(
            '[MembershipChange] updateSubscription WhatsApp error:',
            waError?.message || waError,
          );
        }
      })();
    }

    return res.status(200).json({
      success: true,
      message: 'Subscription updated successfully.',
      subscription,
    });
  } catch (error) {
    console.error('updateSubscription error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update subscription.',
    });
  }
};

export const deleteSubscription = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid id.'});
    }

    const deleted = await Subscription.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({success: false, message: 'Subscription not found.'});
    }

    return res.status(200).json({
      success: true,
      message: 'Subscription deleted successfully.',
    });
  } catch (error) {
    console.error('deleteSubscription error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete subscription.',
    });
  }
};

const normalizeBulkPhone = raw => {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const digits = String(Math.trunc(Math.abs(raw)));
    return digits.length > 10 ? digits.slice(-10) : digits;
  }
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
};

const MONTH_INDEX = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

const toYmd = (year, monthIndex, day) => {
  const y = Number(year);
  const m = Number(monthIndex);
  const d = Number(day);
  if (
    !Number.isInteger(y) ||
    !Number.isInteger(m) ||
    !Number.isInteger(d) ||
    m < 0 ||
    m > 11 ||
    d < 1 ||
    d > 31
  ) {
    return '';
  }
  const dt = new Date(Date.UTC(y, m, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m ||
    dt.getUTCDate() !== d
  ) {
    return '';
  }
  return `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

/**
 * Bulk Excel dates — prefer human format like "29 Jul 2026".
 * Also accepts Date, Excel serial, ISO YYYY-MM-DD, DD-MMM-YYYY, DD/MM/YYYY.
 */
const toBulkIsoDate = value => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return toYmd(value.getFullYear(), value.getMonth(), value.getDate());
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    // Excel serial date (days since 1899-12-30)
    const epoch = Date.UTC(1899, 11, 30);
    const d = new Date(epoch + Math.round(value) * 86400000);
    if (!Number.isNaN(d.getTime())) {
      return toYmd(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    }
  }

  const text = String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!text) return '';

  // ISO: 2026-07-29
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    return toYmd(iso[1], Number(iso[2]) - 1, iso[3]);
  }

  // Preferred Excel text: 29 Jul 2026 | 29-Jul-2026 | 29/Jul/2026
  const dmyMonth = text.match(
    /^(\d{1,2})[ \/\-]([A-Za-z]{3,9})[ \/\-](\d{4})$/,
  );
  if (dmyMonth) {
    const monthIndex = MONTH_INDEX[dmyMonth[2].toLowerCase()];
    if (monthIndex !== undefined) {
      return toYmd(dmyMonth[3], monthIndex, dmyMonth[1]);
    }
  }

  // Numeric DMY: 29/07/2026 or 29-07-2026
  const dmyNum = text.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (dmyNum) {
    return toYmd(dmyNum[3], Number(dmyNum[2]) - 1, dmyNum[1]);
  }

  return '';
};

const resolveMembershipFromExcel = async membershipPlanRaw => {
  const key = String(membershipPlanRaw ?? '').trim();
  if (!key) return null;

  const escaped = escapeRegex(key);
  const plan = await Membership.findOne({
    $or: [
      {planId: new RegExp(`^${escaped}$`, 'i')},
      {displayName: new RegExp(`^${escaped}$`, 'i')},
    ],
  }).lean();

  return plan || null;
};

/** Map Excel header variants → expected camelCase keys */
const BULK_HEADER_ALIASES = {
  customername: 'customerName',
  name: 'customerName',
  customerphone: 'customerPhone',
  phone: 'customerPhone',
  mobile: 'customerPhone',
  membershipplan: 'membershipPlan',
  membership: 'membershipPlan',
  plan: 'membershipPlan',
  startdate: 'startDate',
  start: 'startDate',
  enddate: 'endDate',
  end: 'endDate',
  salespersonname: 'salesPersonName',
  salesperson: 'salesPersonName',
  amount: 'amount',
  status: 'status',
  activity: 'status',
  activitystatus: 'status',
  repeattype: 'repeatType',
  repeatedtype: 'repeatType',
  repeat: 'repeatType',
  notes: 'notes',
  studentname: 'studentName',
  classstd: 'classStd',
  classstandard: 'classStd',
  class: 'classStd',
  relation: 'relation',
  parentname: 'parentName',
  parentsname: 'parentName',
  studentid: 'studentId',
  schoolname: 'schoolName',
  dob: 'dob',
  dateofbirth: 'dob',
};

const normalizeBulkExcelRow = row => {
  const out = {};
  if (!row || typeof row !== 'object') return out;
  for (const [rawKey, value] of Object.entries(row)) {
    const compact = String(rawKey || '')
      .trim()
      .toLowerCase()
      .replace(/[\s_\-./]+/g, '');
    const key = BULK_HEADER_ALIASES[compact] || String(rawKey).trim();
    // Prefer first non-empty value if duplicate aliases collide
    if (out[key] === undefined || out[key] === '' || out[key] === null) {
      out[key] = value;
    }
  }
  return out;
};

/** UTC day window for YYYY-MM-DD comparison against Date fields */
const utcDayRange = isoDate => {
  const day = String(isoDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const start = new Date(`${day}T00:00:00.000Z`);
  const end = new Date(`${day}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return {start, end};
};

/** Stable key used to block re-upload of the same membership row */
const buildBulkDuplicateKey = ({
  customerPhone,
  membershipType,
  membershipPlanId,
  startDate,
  endDate,
  grandTotal,
}) => {
  const phone = normalizeBulkPhone(customerPhone);
  const type = String(membershipType || '')
    .trim()
    .toLowerCase();
  const planId = String(membershipPlanId || '')
    .trim()
    .toLowerCase();
  const start = String(startDate || '').trim();
  const end = String(endDate || '').trim();
  const amount = Math.round((Number(grandTotal) || 0) * 100) / 100;
  return `${phone}|${type}|${planId}|${start}|${end}|${amount}`;
};

/**
 * Find an existing subscription that matches a bulk row
 * (same phone + plan/type + start/end day + amount).
 */
const findExistingBulkDuplicate = async body => {
  const phone = normalizeBulkPhone(body?.customerPhone);
  const membershipType = String(body?.membershipType || '')
    .trim()
    .toLowerCase();
  const membershipPlanId = String(body?.membershipPlanId || '')
    .trim()
    .toLowerCase();
  const amount = Math.round((Number(body?.grandTotal) || 0) * 100) / 100;
  const startRange = utcDayRange(body?.invoiceDate || body?.startDate);
  const endRange = utcDayRange(body?.dueDate || body?.endDate);

  if (!phone || !startRange || !endRange) return null;

  const query = {
    customerPhone: phone,
    grandTotal: amount,
    $and: [
      {
        $or: [
          {startDate: {$gte: startRange.start, $lt: startRange.end}},
          {invoiceDate: {$gte: startRange.start, $lt: startRange.end}},
        ],
      },
      {
        $or: [
          {endDate: {$gte: endRange.start, $lt: endRange.end}},
          {dueDate: {$gte: endRange.start, $lt: endRange.end}},
        ],
      },
    ],
  };
  if (membershipType) query.membershipType = membershipType;
  if (membershipPlanId) {
    query.membershipPlanId = new RegExp(
      `^${escapeRegex(membershipPlanId)}$`,
      'i',
    );
  }

  return Subscription.findOne(query)
    .select('subscriptionCode customerPhone membershipType startDate endDate')
    .lean();
};

const mapExcelRowToCreateBody = async (excelRowRaw, req) => {
  const excelRow = normalizeBulkExcelRow(excelRowRaw);
  const customerName = String(excelRow?.customerName ?? '').trim();
  const customerPhone = normalizeBulkPhone(excelRow?.customerPhone);
  const membershipPlanKey = String(excelRow?.membershipPlan ?? '').trim();
  const startDate = toBulkIsoDate(excelRow?.startDate);
  const endDate = toBulkIsoDate(excelRow?.endDate);
  const salesPersonName =
    String(excelRow?.salesPersonName ?? '').trim() ||
    String(req.user?.name || req.user?.m_staff_name || 'Admin').trim();
  const amount = Math.max(0, Number(excelRow?.amount ?? 0) || 0);
  const statusRaw = String(excelRow?.status ?? 'active').trim().toLowerCase();
  let status = [
    'draft',
    'active',
    'completed',
    'expired',
    'error',
    'cancelled',
  ].includes(statusRaw)
    ? statusRaw
    : 'active';

  // Historical imports: past end dates become expired instead of failing validation
  if (endDate) {
    const end = new Date(`${endDate}T00:00:00.000Z`);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    if (!Number.isNaN(end.getTime()) && end < today && status === 'active') {
      status = 'expired';
    }
  }
  const repeatTypeRaw = String(excelRow?.repeatType ?? 'yearly')
    .trim()
    .toLowerCase();
  const repeatType = ['weekly', 'monthly', 'yearly', 'lifetime'].includes(
    repeatTypeRaw,
  )
    ? repeatTypeRaw
    : 'yearly';
  const notes = String(excelRow?.notes ?? '').trim();

  if (!customerName) throw new Error('customerName is required');
  if (!/^[6-9]\d{9}$/.test(customerPhone)) {
    throw new Error('customerPhone must be a valid 10-digit Indian mobile');
  }
  if (!membershipPlanKey) throw new Error('membershipPlan is required');
  if (!startDate) throw new Error('startDate is required');
  if (!endDate) throw new Error('endDate is required');

  const plan = await resolveMembershipFromExcel(membershipPlanKey);
  if (!plan) {
    throw new Error(`Membership plan not found: ${membershipPlanKey}`);
  }

  const unitPrice =
    amount > 0 ? amount : Math.max(0, Number(plan.pricing?.amount ?? 0) || 0);
  const planLabel = String(plan.displayName || plan.planId || membershipPlanKey);
  const membershipType = String(plan.planId || plan.displayName || 'general')
    .trim()
    .toLowerCase();
  const junior = isJuniorMembership(membershipType);

  // Ensure customer exists (createSubscription only updates existing customers)
  let customer = await Customer.findOne({
    mobile: customerPhone,
    isDeleted: {$ne: true},
  });
  if (!customer) {
    customer = await Customer.create({
      name: customerName,
      mobile: customerPhone,
      membershipType: 'none',
      createdBy: {
        m_staff_id: req.user?.userId ?? null,
        m_staff_name: req.user?.name ?? req.user?.m_staff_name ?? null,
        m_staff_email: req.user?.email ?? null,
      },
    });
  }

  // Junior student/parent columns are optional in bulk — blank cells are allowed.
  const students = [];
  if (junior) {
    const studentName = String(excelRow?.studentName ?? '').trim();
    const classStd = String(excelRow?.classStd ?? '').trim();
    const relation = String(excelRow?.relation ?? '').trim();
    const parentName = String(excelRow?.parentName ?? '').trim();
    const studentId = String(excelRow?.studentId ?? '').trim();
    const schoolName = String(excelRow?.schoolName ?? '').trim();
    const dob = toBulkIsoDate(excelRow?.dob) || null;
    const hasAnyStudentData = Boolean(
      studentName ||
        classStd ||
        relation ||
        parentName ||
        studentId ||
        schoolName ||
        dob,
    );

    if (hasAnyStudentData) {
      students.push({
        studentName,
        schoolName,
        dob,
        classStd,
        relation,
        parentName: parentName || customerName,
        studentId,
      });
    }
  }

  return {
    customerName: customer.name || customerName,
    customerPhone,
    membershipId: String(plan._id),
    membershipPlanId: String(plan.planId || ''),
    membershipType,
    priority: Number(plan.priority ?? 0) || 0,
    invoiceDate: startDate,
    dueDate: endDate,
    repeatType,
    repeatEvery: repeatType === 'lifetime' ? null : 1,
    repeatUnit:
      repeatType === 'lifetime'
        ? null
        : repeatType === 'yearly'
          ? 'year'
          : 'month',
    salesPersonName,
    notes,
    items: [
      {
        productName: planLabel,
        qty: 1,
        unitPrice,
        discount: 0,
        category: 'membership',
      },
    ],
    students,
    subTotal: unitPrice,
    discountTotal: 0,
    grandTotal: unitPrice,
    status,
    // Bulk may import historical memberships with past end dates
    allowPastEndDate: true,
    // Bulk junior rows may omit student / parent / DOB columns
    allowOptionalJuniorStudents: true,
    createdBy: {
      m_staff_id: req.user?.userId ?? null,
      m_staff_name: req.user?.name ?? req.user?.m_staff_name ?? null,
      m_staff_email: req.user?.email ?? null,
    },
  };
};

/**
 * POST /subscriptions/bulk
 * Body: { subscriptions: ExcelRow[] }
 */
export const bulkCreateSubscriptions = async (req, res) => {
  try {
    const {subscriptions} = req.body || {};

    if (!subscriptions || !Array.isArray(subscriptions)) {
      return res.status(400).json({
        success: false,
        message: 'No subscriptions array provided.',
      });
    }

    if (!subscriptions.length) {
      return res.status(400).json({
        success: false,
        message: 'subscriptions array is empty.',
      });
    }

    const results = [];
    let successCount = 0;
    let failedCount = 0;
    let skippedCount = 0;
    /** Prevent same-file duplicates within one upload batch */
    const seenInBatch = new Set();

    for (let index = 0; index < subscriptions.length; index += 1) {
      const excelRow = normalizeBulkExcelRow(subscriptions[index]);
      try {
        const body = await mapExcelRowToCreateBody(excelRow, req);
        const dupKey = buildBulkDuplicateKey(body);

        if (seenInBatch.has(dupKey)) {
          skippedCount += 1;
          results.push({
            index,
            success: false,
            skipped: true,
            duplicate: true,
            customerPhone: body.customerPhone,
            message:
              'Duplicate in this file — same phone, membership, dates and amount already processed in an earlier row. Skipped.',
          });
          continue;
        }

        const existing = await findExistingBulkDuplicate(body);
        if (existing) {
          skippedCount += 1;
          results.push({
            index,
            success: false,
            skipped: true,
            duplicate: true,
            customerPhone: body.customerPhone,
            subscriptionCode: existing.subscriptionCode,
            message: `Duplicate — already exists as ${existing.subscriptionCode || 'subscription'} (same phone, membership, dates and amount). Skipped.`,
          });
          continue;
        }

        seenInBatch.add(dupKey);

        let createResult = null;
        const fakeRes = {
          status(code) {
            this.statusCode = code;
            return this;
          },
          json(payload) {
            createResult = {
              statusCode: this.statusCode || 200,
              payload,
            };
            return createResult;
          },
        };

        await createSubscription({...req, body}, fakeRes);

        if (createResult?.payload?.success) {
          successCount += 1;
          results.push({
            index,
            success: true,
            customerPhone: body.customerPhone,
            subscriptionCode:
              createResult.payload?.subscription?.subscriptionCode,
            message: createResult.payload?.message || 'Created',
          });
        } else {
          // Allow retry of this key if create failed
          seenInBatch.delete(dupKey);
          failedCount += 1;
          results.push({
            index,
            success: false,
            customerPhone: body.customerPhone,
            message:
              createResult?.payload?.message ||
              (Array.isArray(createResult?.payload?.errors)
                ? createResult.payload.errors.join(' ')
                : 'Failed to create subscription'),
          });
        }
      } catch (rowError) {
        failedCount += 1;
        results.push({
          index,
          success: false,
          customerPhone: normalizeBulkPhone(excelRow?.customerPhone),
          message: rowError?.message || 'Failed to process row',
        });
      }
    }

    const httpStatus =
      failedCount === 0 && (successCount > 0 || skippedCount > 0)
        ? successCount > 0
          ? 201
          : 200
        : successCount === 0
          ? 400
          : 200;

    return res.status(httpStatus).json({
      success: failedCount === 0,
      message: `Processed ${subscriptions.length} row(s): ${successCount} created, ${skippedCount} duplicate skipped, ${failedCount} failed.`,
      summary: {
        total: subscriptions.length,
        successful: successCount,
        skipped: skippedCount,
        failed: failedCount,
      },
      results,
    });
  } catch (error) {
    console.error('Bulk upload error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to bulk upload subscriptions.',
    });
  }
};

const phoneDigits = raw => String(raw || '').replace(/\D/g, '');

const phoneLookupVariants = phone => {
  const digits = phoneDigits(phone);
  if (!digits) return [];
  const ten =
    digits.length === 12 && digits.startsWith('91')
      ? digits.slice(2)
      : digits.length >= 10
        ? digits.slice(-10)
        : digits;
  return [
    ...new Set(
      [digits, ten, `+91${ten}`, `91${ten}`, `0${ten}`].filter(Boolean),
    ),
  ];
};

const daysUntilEndDate = endDate => {
  if (!endDate) return null;
  const end = new Date(endDate);
  if (Number.isNaN(end.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  return Math.ceil((end.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
};

const isRenewalReminderEligible = subscription => {
  const status = String(subscription?.status || '').toLowerCase();
  if (status === 'cancelled' || status === 'draft' || status === 'error') {
    return false;
  }
  if (status === 'expired') return true;

  const soonDays = Math.max(
    1,
    Number(process.env.WHATSAPP_MEMBERSHIP_RENEWAL_SOON_DAYS || 30) || 30,
  );
  const days = daysUntilEndDate(subscription?.endDate ?? subscription?.dueDate);
  if (days == null) return false;
  return days <= soonDays; // includes already expired (negative)
};

/**
 * POST /subscriptions/:id/whatsapp-renewal
 * Send Meta template `membershiprenewal` for one subscription row.
 */
export const sendMembershipRenewalReminder = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid subscription id.'});
    }

    const subscription = await Subscription.findById(id);
    if (!subscription) {
      return res.status(404).json({success: false, message: 'Subscription not found.'});
    }

    if (!isRenewalReminderEligible(subscription)) {
      return res.status(400).json({
        success: false,
        message:
          'Renewal reminder is only available for expired or soon-to-expire memberships.',
      });
    }

    const phone =
      String(subscription.customerPhone || '').trim() ||
      '';
    const variants = phoneLookupVariants(phone);
    if (!variants.length) {
      return res.status(400).json({
        success: false,
        message: 'Customer has no valid WhatsApp / mobile number.',
      });
    }

    const customer = await Customer.findOne({
      $or: [
        {mobile: {$in: variants}},
        {whatsappNumber: {$in: variants}},
      ],
      isDeleted: {$ne: true},
    })
      .select('_id name mobile whatsappNumber membershipType')
      .lean();

    const whatsappTo =
      String(customer?.whatsappNumber || '').trim() ||
      String(customer?.mobile || '').trim() ||
      phone;

    if (!whatsappTo) {
      return res.status(400).json({
        success: false,
        message: 'Customer has no valid WhatsApp / mobile number.',
      });
    }

    const daysRaw = daysUntilEndDate(
      subscription.endDate ?? subscription.dueDate,
    );
    const daysUntilExpiry = daysRaw == null ? 0 : Math.max(0, daysRaw);

    // Lifetime membership savings from invoices (membership discounts)
    let savingsAmount = 0;
    try {
      const agg = await Invoice.aggregate([
        {
          $match: {
            status: {$nin: ['cancelled', 'Canceled', 'draft']},
            $or: [
              ...(customer?._id ? [{customerId: customer._id}] : []),
              {customerPhone: {$in: variants}},
            ],
          },
        },
        {
          $group: {
            _id: null,
            saved: {
              $sum: {
                $add: [
                  {$ifNull: ['$membershipDiscount', 0]},
                  {$ifNull: ['$cashbackTotal', 0]},
                ],
              },
            },
          },
        },
      ]);
      savingsAmount = Math.max(0, Number(agg?.[0]?.saved || 0));
    } catch (aggErr) {
      console.warn(
        '[MembershipRenewal] savings aggregate failed:',
        aggErr?.message || aggErr,
      );
    }

    const planId = String(
      subscription.membershipType || subscription.membershipPlanId || '',
    )
      .trim()
      .toLowerCase();
    let planName = planId
      ? planId.charAt(0).toUpperCase() + planId.slice(1)
      : 'Membership';
    let renewCashback = Number(
      process.env.WHATSAPP_MEMBERSHIP_RENEWAL_CASHBACK ||
        process.env.WHATSAPP_MEMBERSHIP_CASHBACK ||
        200,
    );

    try {
      const membership = await Membership.findOne({
        $or: [{planId}, {planId: subscription.membershipPlanId}],
        status: {$in: ['Active', 'Inactive', 'active', 'inactive']},
      })
        .select('displayName planId walletCashback')
        .lean();
      if (membership?.displayName) {
        planName = String(membership.displayName).replace(/\s*Membership$/i, '').trim() || planName;
      }
      const planCashback = Number(membership?.walletCashback?.amount ?? 0);
      if (planCashback > 0) renewCashback = planCashback;
    } catch {
      // keep defaults
    }

    const displayName =
      String(customer?.name || subscription.customerName || 'Member').trim() ||
      'Member';

    const staff = {
      m_staff_id: req.user?.userId ?? req.staff?.m_staff_id ?? null,
      m_staff_name: req.user?.name ?? req.staff?.m_staff_name ?? null,
      m_staff_email: req.user?.email ?? req.staff?.m_staff_email ?? null,
    };

    let result;
    try {
      result = await sendMembershipRenewalWhatsApp({
        to: whatsappTo,
        name: displayName,
        daysUntilExpiry,
        savingsAmount,
        planName,
        cashbackAmount: renewCashback,
      });
    } catch (sendErr) {
      await WhatsAppReminderLog.create({
        subscriptionId: subscription._id,
        customerId: customer?._id || null,
        customerName: displayName,
        phone: whatsappTo,
        templateName: 'membershiprenewal',
        bodyParams: [],
        status: 'failed',
        errorMessage: sendErr?.message || 'WhatsApp send failed',
        sentBy: staff,
      });
      subscription.lastRenewalReminderAt = new Date();
      subscription.lastRenewalReminderStatus = 'failed';
      await subscription.save();

      return res.status(502).json({
        success: false,
        message: sendErr?.message || 'Failed to send WhatsApp reminder.',
      });
    }

    const delivered = Boolean(result?.delivered || result?.stub);
    const logStatus = delivered || result?.stub ? 'success' : 'failed';

    await WhatsAppReminderLog.create({
      subscriptionId: subscription._id,
      customerId: customer?._id || null,
      customerName: displayName,
      phone: whatsappTo,
      templateName: result?.templateName || 'membershiprenewal',
      languageCode: result?.language || '',
      bodyParams: result?.bodyParams || [],
      status: logStatus,
      messageId: result?.messageId || null,
      errorMessage: result?.stub ? 'Sent in stub mode (no WhatsApp credentials)' : '',
      sentBy: staff,
    });

    subscription.lastRenewalReminderAt = new Date();
    subscription.lastRenewalReminderStatus = logStatus;
    subscription.lastRenewalReminderMessageId = result?.messageId || null;
    await subscription.save();

    return res.status(200).json({
      success: true,
      message: result?.stub
        ? 'Reminder logged (WhatsApp stub — configure credentials to send live).'
        : 'WhatsApp reminder sent successfully.',
      reminder: {
        subscriptionId: String(subscription._id),
        phone: whatsappTo,
        templateName: result?.templateName || 'membershiprenewal',
        messageId: result?.messageId || null,
        stub: Boolean(result?.stub),
        bodyParams: result?.bodyParams || [],
        lastRenewalReminderAt: subscription.lastRenewalReminderAt,
        lastRenewalReminderStatus: subscription.lastRenewalReminderStatus,
      },
    });
  } catch (error) {
    console.error('sendMembershipRenewalReminder error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to send membership renewal reminder.',
    });
  }
};


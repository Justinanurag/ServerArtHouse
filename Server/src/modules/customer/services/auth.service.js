import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Customer from '../../../models/customer.model.js';
import Counter from '../../../models/counter.model.js';
import CustomerRefreshToken from '../models/customerRefreshToken.model.js';
import {
  createAndSendOtp,
  verifyOtpCode,
} from './otp.service.js';
import {sendMembershipPurchaseWhatsApp, sendMembershipChangeWhatsApp, sendAccountCreatedWhatsApp} from './whatsapp.service.js';
import {validateMembershipCoupon} from './coupon.service.js';
import Coupon from '../../../models/coupon.model.js';
import PaymentOrder from '../models/paymentOrder.model.js';
import {getMembershipOrderAmount} from '../constants/membershipPlans.js';
import {
  assertActiveMembershipPlan,
  resolvePlanMeta,
} from '../../../services/membershipPlan.service.js';
import {creditInviteReward} from './referral.service.js';
import Wallet from '../../../models/wallet.model.js';
import {creditPlanPurchaseCashback} from '../../../controllers/subscription.controller.js';
import {ensureSubscriptionForMembership} from '../../../services/subscriptionFromMembership.service.js';
import {
  generateAccessToken,
  createRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllCustomerRefreshTokens,
  setAuthCookies,
  clearAuthCookies,
  hashToken,
} from '../utils/token.js';
import {
  normalizeMobile,
  parseIdentifier,
  isEmail,
} from '../utils/normalize.js';

const SALT_ROUNDS = 12;
const AUTO_CREATE_ON_OTP =
  String(process.env.CUSTOMER_OTP_AUTO_CREATE || 'true').toLowerCase() !==
  'false';

const getNextCustomerId = async () => {
  const counter = await Counter.findOneAndUpdate(
    {key: 'customer_portal_id'},
    {$inc: {value: 1}},
    {new: true, upsert: true, setDefaultsOnInsert: true},
  );
  return `CUST${String(counter.value).padStart(6, '0')}`;
};

const getWelcomeBonusAmount = () => {
  const amount = Number(
    process.env.WHATSAPP_ACCOUNT_CREATED_CASHBACK ||
      process.env.ACCOUNT_WELCOME_CASHBACK ||
      21,
  );
  return Number.isFinite(amount) && amount > 0 ? amount : 21;
};

const applyWelcomeBonus = async customer => {
  if (customer.welcomeBonusCredited) return 0;
  const amount = getWelcomeBonusAmount();
  if (!(amount > 0) || !customer?._id) return 0;

  customer.welcomeBonusCredited = true;
  customer.walletAmount = Number(customer.walletAmount || 0) + amount;

  try {
    let wallet = await Wallet.findOne({customerId: customer._id});
    if (!wallet) {
      wallet = await Wallet.create({
        customerId: customer._id,
        customerName: String(customer.name ?? '').trim(),
        customerPhone: String(customer.mobile ?? '').trim(),
        // Seed with pre-bonus balance; appendTransaction adds the welcome credit
        walletAmount: Math.max(0, Number(customer.walletAmount || 0) - amount),
        cashbackBalance: Math.max(0, Number(customer.cashbackBalance ?? 0) || 0),
        affiliateBalance: Math.max(0, Number(customer.affiliateBalance ?? 0) || 0),
        transactions: [],
      });
    }

    const ref = `welcome:${customer._id}`;
    const alreadyCredited = (wallet.transactions || []).some(
      tx =>
        String(tx.referenceId || '').trim() === ref ||
        (/welcome|signup/i.test(String(tx.note || '')) &&
          String(tx.type || '').toLowerCase() === 'credit'),
    );

    if (!alreadyCredited) {
      // Customer already includes the bonus above — seed wallet general to pre-bonus
      // so appendTransaction lands on the correct closing balance.
      const preBonusGeneral = Math.max(
        0,
        Number(customer.walletAmount || 0) - amount,
      );
      wallet.walletAmount = preBonusGeneral;
      const {appendTransaction} = await import(
        '../../../controllers/wallet.controller.js'
      );
      await appendTransaction(wallet, {
        type: 'credit',
        amount,
        note: 'Signup welcome bonus',
        referenceType: 'WelcomeBonus',
        referenceId: ref,
        walletType: 'nonWithdrawable',
        createdBy: {
          m_staff_id: null,
          m_staff_name: 'System',
          m_staff_email: null,
        },
      });
      // appendTransaction already synced customer.walletAmount; keep in-memory in sync
      customer.walletAmount = preBonusGeneral + amount;
    }
  } catch (error) {
    console.error(
      '[WelcomeBonus] wallet ledger credit failed:',
      error?.message || error,
    );
  }

  return amount;
};

/** Credit welcome ₹21 (once) and send accountcreated WhatsApp (once). */
const notifyAccountCreated = async customer => {
  if (customer.accountCreatedWhatsAppSent) {
    return {whatsapp: {delivered: false, skipped: true}, cashback: 0};
  }

  const credited = await applyWelcomeBonus(customer);
  const cashbackLabel = String(getWelcomeBonusAmount());

  let whatsapp = null;
  try {
    whatsapp = await sendAccountCreatedWhatsApp({
      to: customer.mobile,
      name: customer.name || 'Member',
      cashbackLabel,
    });
  } catch (err) {
    console.error('[AccountCreated] WhatsApp send error:', err?.message || err);
    whatsapp = {delivered: false, error: err?.message || 'WhatsApp send failed'};
  }

  // Mark sent even if WhatsApp failed so we don't spam on every profile save
  customer.accountCreatedWhatsAppSent = true;
  await customer.save();

  return {whatsapp, cashback: credited || getWelcomeBonusAmount()};
};

const ensureCustomerId = async customer => {
  if (customer.customerId) return customer;
  customer.customerId = await getNextCustomerId();
  await customer.save();
  return customer;
};

const issueSession = async (res, customer, meta = {}) => {
  await ensureCustomerId(customer);
  customer.lastLogin = new Date();
  if (meta.deviceInfo) customer.deviceInfo = meta.deviceInfo;
  await customer.save();

  const accessToken = generateAccessToken(customer);
  const {raw: refreshToken} = await createRefreshToken(customer, meta);
  setAuthCookies(res, {accessToken, refreshToken});

  return {
    customer: customer.toSafeObject(),
    token: accessToken,
    refreshToken,
  };
};

const findActiveCustomer = query =>
  Customer.findOne({...query, isDeleted: {$ne: true}});

export const signupCustomer = async (res, payload, meta = {}) => {
  const name = String(payload.name || '').trim();
  const mobile = normalizeMobile(payload.mobile);
  const email = payload.email ? String(payload.email).trim().toLowerCase() : '';
  const password = payload.password;
  const countryCode = payload.countryCode || '+91';
  const gender = payload.gender || '';
  const dob = payload.dob || null;

  if (!name || !mobile || !password) {
    const error = new Error('Name, mobile, and password are required');
    error.status = 400;
    throw error;
  }

  const existingMobile = await findActiveCustomer({mobile});
  if (existingMobile?.password) {
    const error = new Error('Mobile number is already registered');
    error.status = 409;
    throw error;
  }

  if (email) {
    const existingEmail = await findActiveCustomer({email});
    if (existingEmail && (!existingMobile || String(existingEmail._id) !== String(existingMobile._id))) {
      const error = new Error('Email is already registered');
      error.status = 409;
      throw error;
    }
  }

  let referredBy = null;
  if (payload.ref) {
    const inviterCode = String(payload.ref).trim().toUpperCase();
    const inviter = await findActiveCustomer({ referralCode: inviterCode });
    if (inviter) {
      referredBy = inviter._id;
    }
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  let customer = existingMobile;

  if (customer) {
    customer.name = name;
    customer.password = passwordHash;
    customer.countryCode = countryCode;
    customer.loginType = customer.loginType === 'otp' ? 'both' : 'password';
    if (email) customer.email = email;
    if (gender) customer.gender = gender;
    if (dob) customer.dob = dob;
    if (!customer.customerId) customer.customerId = await getNextCustomerId();
    await customer.save();
  } else {
    customer = await Customer.create({
      name,
      mobile,
      email,
      countryCode,
      password: passwordHash,
      gender,
      dob,
      customerId: await getNextCustomerId(),
      loginType: 'password',
      status: 'active',
      isVerified: false,
      mobileVerified: false,
      emailVerified: false,
      profileSetupCompleted: false,
      onboardingCompleted: false,
      welcomeBonusCredited: false,
      accountCreatedWhatsAppSent: false,
      referredBy,
      referredAt: referredBy ? new Date() : null,
    });
    try {
      await creditInviteReward({
        referredCustomerId: customer._id,
        orderAmount: 0,
        paidAmount: 0,
        sourceId: `registration:${customer._id}`,
        eventTrigger: 'registration',
      });
    } catch (error) {
      console.error('[Referral] Registration reward failed:', error?.message || error);
    }
    await notifyAccountCreated(customer);
  }

  return issueSession(res, customer, meta);
};

export const loginWithPassword = async (res, payload, meta = {}) => {
  const parsed = parseIdentifier(payload.identifier || payload.email || payload.mobile);
  if (!parsed || !payload.password) {
    const error = new Error('Valid email/mobile and password are required');
    error.status = 400;
    throw error;
  }

  const query =
    parsed.type === 'email' ? {email: parsed.value} : {mobile: parsed.value};

  const customer = await Customer.findOne({...query, isDeleted: {$ne: true}}).select(
    '+password',
  );

  if (!customer || !customer.password) {
    const error = new Error('Invalid credentials');
    error.status = 401;
    throw error;
  }

  if (customer.status === 'blocked') {
    const error = new Error('Your account has been blocked. Contact support.');
    error.status = 403;
    throw error;
  }

  const match = await bcrypt.compare(payload.password, customer.password);
  if (!match) {
    const error = new Error('Invalid credentials');
    error.status = 401;
    throw error;
  }

  return issueSession(res, customer, meta);
};

export const requestLoginOtp = async payload => {
  const mobile = normalizeMobile(payload.mobile || payload.identifier);
  if (!mobile) {
    const error = new Error('Valid mobile number is required');
    error.status = 400;
    throw error;
  }

  let customer = await findActiveCustomer({mobile});

  if (!customer && !AUTO_CREATE_ON_OTP) {
    const error = new Error('No account found with this mobile number');
    error.status = 404;
    throw error;
  }

  return createAndSendOtp({
    identifier: mobile,
    identifierType: 'mobile',
    purpose: 'login',
    meta: {autoCreate: AUTO_CREATE_ON_OTP},
  });
};

export const verifyLoginOtp = async (res, payload, meta = {}) => {
  const mobile = normalizeMobile(payload.mobile || payload.identifier);
  if (!mobile || !payload.otp) {
    const error = new Error('Mobile number and OTP are required');
    error.status = 400;
    throw error;
  }

  await verifyOtpCode({
    identifier: mobile,
    identifierType: 'mobile',
    purpose: 'login',
    otp: payload.otp,
  });

  let customer = await findActiveCustomer({mobile});

  if (!customer) {
    if (!AUTO_CREATE_ON_OTP) {
      const error = new Error('No account found with this mobile number');
      error.status = 404;
      throw error;
    }

    let referredBy = null;
    if (payload.ref) {
      const inviterCode = String(payload.ref).trim().toUpperCase();
      const inviter = await findActiveCustomer({ referralCode: inviterCode });
      if (inviter) {
        referredBy = inviter._id;
      }
    }

    customer = await Customer.create({
      name: payload.name || `Customer ${mobile.slice(-4)}`,
      mobile,
      countryCode: payload.countryCode || '+91',
      customerId: await getNextCustomerId(),
      loginType: 'otp',
      mobileVerified: true,
      isVerified: true,
      status: 'active',
      profileSetupCompleted: false,
      onboardingCompleted: false,
      welcomeBonusCredited: false,
      accountCreatedWhatsAppSent: false,
      referredBy,
      referredAt: referredBy ? new Date() : null,
    });
    // Credit welcome bonus now; WhatsApp waits until Create Account (real name)
    await applyWelcomeBonus(customer);
    await customer.save();
    try {
      await creditInviteReward({
        referredCustomerId: customer._id,
        orderAmount: 0,
        paidAmount: 0,
        sourceId: `registration:${customer._id}`,
        eventTrigger: 'registration',
      });
    } catch (error) {
      console.error('[Referral] Registration reward failed:', error?.message || error);
    }
  } else {
    customer.mobileVerified = true;
    customer.isVerified = true;
    if (!customer.loginType) customer.loginType = 'otp';
    else if (customer.loginType === 'password') customer.loginType = 'both';
    await ensureCustomerId(customer);
  }

  return issueSession(res, customer, meta);
};

export const resendOtp = async payload => {
  const purpose = payload.purpose || 'login';
  const identifier = payload.identifier || payload.mobile || payload.email;
  const identifierType = isEmail(identifier) ? 'email' : 'mobile';

  if (!identifier) {
    const error = new Error('Mobile number or email is required');
    error.status = 400;
    throw error;
  }

  if (purpose === 'forgot-password') {
    const parsed = parseIdentifier(identifier);
    if (!parsed) {
      const error = new Error('Valid email or mobile is required');
      error.status = 400;
      throw error;
    }
    const query =
      parsed.type === 'email' ? {email: parsed.value} : {mobile: parsed.value};
    const customer = await findActiveCustomer(query);
    if (!customer) {
      const error = new Error('No account found with these details');
      error.status = 404;
      throw error;
    }
  }

  return createAndSendOtp({
    identifier,
    identifierType,
    purpose,
  });
};

export const forgotPasswordRequest = async payload => {
  const parsed = parseIdentifier(payload.identifier || payload.email || payload.mobile);
  if (!parsed) {
    const error = new Error('Valid email or mobile is required');
    error.status = 400;
    throw error;
  }

  const query =
    parsed.type === 'email' ? {email: parsed.value} : {mobile: parsed.value};
  const customer = await findActiveCustomer(query);

  if (!customer) {
    const error = new Error('No account found with these details');
    error.status = 404;
    throw error;
  }

  return createAndSendOtp({
    identifier: parsed.value,
    identifierType: parsed.type,
    purpose: 'forgot-password',
  });
};

export const verifyForgotPasswordOtp = async payload => {
  const parsed = parseIdentifier(payload.identifier || payload.email || payload.mobile);
  if (!parsed || !payload.otp) {
    const error = new Error('Identifier and OTP are required');
    error.status = 400;
    throw error;
  }

  await verifyOtpCode({
    identifier: parsed.value,
    identifierType: parsed.type,
    purpose: 'forgot-password',
    otp: payload.otp,
  });

  const resetToken = jwt.sign(
    {
      sub: parsed.value,
      type: 'customer-password-reset',
      identifierType: parsed.type,
    },
    process.env.CUSTOMER_JWT_ACCESS_SECRET ||
      process.env.JWT_SECRET ||
      'customer-access-dev-secret',
    {expiresIn: '10m'},
  );

  return {
    verified: true,
    purpose: 'forgot-password',
    identifier: parsed.value,
    resetToken,
  };
};

export const resetPassword = async payload => {
  const parsed = parseIdentifier(payload.identifier || payload.email || payload.mobile);
  if (!parsed || !payload.newPassword) {
    const error = new Error('Identifier and new password are required');
    error.status = 400;
    throw error;
  }

  if (payload.resetToken) {
    try {
      const decoded = jwt.verify(
        payload.resetToken,
        process.env.CUSTOMER_JWT_ACCESS_SECRET ||
          process.env.JWT_SECRET ||
          'customer-access-dev-secret',
      );
      if (
        decoded.type !== 'customer-password-reset' ||
        decoded.sub !== parsed.value
      ) {
        const error = new Error('Invalid reset token');
        error.status = 400;
        throw error;
      }
    } catch (err) {
      if (err.status) throw err;
      const error = new Error('Invalid or expired reset token');
      error.status = 400;
      throw error;
    }
  } else if (payload.otp) {
    await verifyOtpCode({
      identifier: parsed.value,
      identifierType: parsed.type,
      purpose: 'forgot-password',
      otp: payload.otp,
    });
  } else {
    const error = new Error('OTP or reset token is required');
    error.status = 400;
    throw error;
  }

  const query =
    parsed.type === 'email' ? {email: parsed.value} : {mobile: parsed.value};
  const customer = await Customer.findOne({
    ...query,
    isDeleted: {$ne: true},
  }).select('+password');

  if (!customer) {
    const error = new Error('Customer not found');
    error.status = 404;
    throw error;
  }

  customer.password = await bcrypt.hash(payload.newPassword, SALT_ROUNDS);
  if (!customer.loginType) customer.loginType = 'password';
  else if (customer.loginType === 'otp') customer.loginType = 'both';
  await customer.save();

  return {customer: customer.toSafeObject()};
};

export const refreshCustomerSession = async (res, rawRefreshToken, meta = {}) => {
  if (!rawRefreshToken) {
    const error = new Error('Refresh token missing');
    error.status = 401;
    throw error;
  }

  const rotated = await rotateRefreshToken(rawRefreshToken, meta);
  if (!rotated) {
    clearAuthCookies(res);
    const error = new Error('Invalid or expired refresh token');
    error.status = 401;
    throw error;
  }

  const customer = await findActiveCustomer({_id: rotated.customerId});
  if (!customer || customer.status === 'blocked') {
    clearAuthCookies(res);
    const error = new Error('Customer not found or blocked');
    error.status = 401;
    throw error;
  }

  const accessToken = generateAccessToken(customer);
  setAuthCookies(res, {
    accessToken,
    refreshToken: rotated.raw,
  });

  return {
    customer: customer.toSafeObject(),
    token: accessToken,
    refreshToken: rotated.raw,
  };
};

export const logoutCustomer = async (res, rawRefreshToken) => {
  await revokeRefreshToken(rawRefreshToken);
  clearAuthCookies(res);
  return true;
};

export const getCustomerProfile = async customerId => {
  const customer = await findActiveCustomer({_id: customerId});
  if (!customer) {
    const error = new Error('Customer not found');
    error.status = 404;
    throw error;
  }
  return customer.toSafeObject();
};

export const updateCustomerProfile = async (customerId, payload) => {
  const customer = await findActiveCustomer({_id: customerId});
  if (!customer) {
    const error = new Error('Customer not found');
    error.status = 404;
    throw error;
  }

  const wasProfileSetupDone = customer.profileSetupCompleted === true;

  const allowed = [
    'name',
    'email',
    'gender',
    'dob',
    'address',
    'city',
    'state',
    'country',
    'pincode',
    'profileImage',
    'whatsappNumber',
    'membershipType',
    'profileSetupCompleted',
    'onboardingCompleted',
  ];

  for (const key of allowed) {
    if (payload[key] !== undefined) {
      customer[key] =
        key === 'email' && payload[key]
          ? String(payload[key]).trim().toLowerCase()
          : payload[key];
    }
  }

  if (payload.email) {
    const conflict = await findActiveCustomer({
      email: customer.email,
      _id: {$ne: customer._id},
    });
    if (conflict) {
      const error = new Error('Email is already in use');
      error.status = 409;
      throw error;
    }
    customer.emailVerified = false;
  }

  await customer.save();

  // After Create Account form — send accountcreated WhatsApp with real name
  const justCompletedProfileSetup =
    payload.profileSetupCompleted === true && !wasProfileSetupDone;
  if (justCompletedProfileSetup && !customer.accountCreatedWhatsAppSent) {
    await notifyAccountCreated(customer);
  }

  return customer.toSafeObject();
};

export const deleteCustomerAccount = async (res, customerId) => {
  const customer = await findActiveCustomer({_id: customerId});
  if (!customer) {
    const error = new Error('Customer not found');
    error.status = 404;
    throw error;
  }

  const stamp = Date.now();
  customer.isDeleted = true;
  customer.deletedAt = new Date();
  customer.status = 'inactive';
  // Free unique mobile/email so the same number can register again
  customer.mobile = `${customer.mobile}_del_${stamp}`.slice(0, 40);
  if (customer.email) {
    customer.email = `deleted_${stamp}_${customer.email}`.slice(0, 120);
  }
  if (customer.customerId) {
    customer.customerId = `${customer.customerId}_del_${stamp}`.slice(0, 40);
  }
  customer.password = null;
  await customer.save({validateBeforeSave: false});

  await revokeAllCustomerRefreshTokens(customerId);
  clearAuthCookies(res);
  return true;
};

const MEMBERSHIP_META = {
  general: {label: 'General Membership', validity: 'Lifetime'},
  special: {label: 'Special Membership', validity: 'Yearly'},
  junior: {label: 'Junior Membership', validity: 'Till School Life'},
  premium: {label: 'Premium Membership', validity: 'Yearly'},
  pro: {label: 'Pro Membership', validity: 'Yearly'},
};

/**
 * Activate a membership after PayU success (or free / ₹0 after coupon).
 * Paid plans require a successful PaymentOrder unless skipPaymentCheck + paymentOrderId path.
 */
export const activateMembership = async (customerId, payload = {}) => {
  let membershipType = String(payload.membershipType || '').toLowerCase();
  let membershipPlan = null;
  try {
    membershipPlan = await assertActiveMembershipPlan(membershipType);
  } catch {
    membershipPlan = null;
  }
  let meta = membershipPlan ? resolvePlanMeta(membershipPlan) : MEMBERSHIP_META[membershipType];

  if ((!meta || membershipType === 'none') && !payload.paymentOrderId) {
    const error = new Error('Select a valid membership plan');
    error.status = 400;
    throw error;
  }

  const customer = await findActiveCustomer({_id: customerId});
  if (!customer) {
    const error = new Error('Customer not found');
    error.status = 404;
    throw error;
  }

  const priorMembershipType = String(customer.membershipType || 'none')
    .trim()
    .toLowerCase();
  const isMembershipUpgrade =
    Boolean(priorMembershipType) &&
    priorMembershipType !== 'none' &&
    !priorMembershipType.includes('junior') &&
    !priorMembershipType.includes('junoir');

  let orderAmount = null;
  let discountAmount = 0;
  let couponCode = null;
  let paidAmount = 0;
  let paymentOrder = null;
  let couponSnapshot = null;

  if (payload.paymentOrderId) {
    paymentOrder = await PaymentOrder.findById(payload.paymentOrderId);
    if (!paymentOrder || String(paymentOrder.customer) !== String(customerId)) {
      const error = new Error('Payment order not found');
      error.status = 404;
      throw error;
    }
    if (paymentOrder.status !== 'success') {
      const error = new Error('Payment is not successful yet');
      error.status = 400;
      throw error;
    }

    // Idempotent: already activated for this payment
    if (
      customer.membershipPurchase?.paymentOrderId &&
      String(customer.membershipPurchase.paymentOrderId) === String(paymentOrder._id)
    ) {
      // Still ensure Subscription row exists (legacy activations skipped this)
      try {
        await ensureSubscriptionForMembership({
          customer,
          membershipType: paymentOrder.membershipType || customer.membershipType,
          membershipPlan: null,
          orderAmount: paymentOrder.orderAmount,
          discountAmount: paymentOrder.discountAmount,
          paidAmount: paymentOrder.paidAmount,
          couponCode: paymentOrder.couponCode || null,
          paymentOrder,
          createdBy: {
            m_staff_id: null,
            m_staff_name: 'Customer Portal',
            m_staff_email: null,
          },
        });
      } catch (subErr) {
        console.error(
          '[Membership] ensure Subscription on re-activate failed:',
          subErr?.message || subErr,
        );
      }
      return {
        customer: customer.toSafeObject(),
        cashback: 0,
        pricing: {
          orderAmount: paymentOrder.orderAmount,
          discountAmount: paymentOrder.discountAmount,
          paidAmount: paymentOrder.paidAmount,
          coupon: paymentOrder.couponCode
            ? {code: paymentOrder.couponCode}
            : null,
        },
        whatsapp: null,
        alreadyActivated: true,
      };
    }

    membershipType = paymentOrder.membershipType;
    orderAmount = paymentOrder.orderAmount;
    discountAmount = paymentOrder.discountAmount;
    paidAmount = paymentOrder.paidAmount;
    couponCode = paymentOrder.couponCode || null;
    if (couponCode) {
      couponSnapshot = {code: couponCode, discountAmount};
    }
  } else {
    if (!meta || membershipType === 'none') {
      const error = new Error('Select a valid membership plan');
      error.status = 400;
      throw error;
    }

    orderAmount = await getMembershipOrderAmount(membershipType);
    if (orderAmount == null) {
      const error = new Error('Select a valid membership plan');
      error.status = 400;
      throw error;
    }

    const rawCoupon = String(payload.couponCode || '').trim();
    if (rawCoupon) {
      const validated = await validateMembershipCoupon({
        code: rawCoupon,
        membershipType,
        customerPhone: customer.mobile,
      });
      discountAmount = validated.discountAmount;
      couponCode = validated.code;
      couponSnapshot = {
        code: validated.code,
        title: validated.title,
        discountType: validated.discountType,
        discountValue: validated.discountValue,
        discountAmount: validated.discountAmount,
      };
    }

    paidAmount = Math.max(0, Math.round((orderAmount - discountAmount) * 100) / 100);

    // Paid activation must go through PayU (unless internal free checkout path)
    if (paidAmount > 0 && !payload.skipPaymentCheck) {
      const error = new Error(
        'Payment required. Use PayU checkout to buy this membership.',
      );
      error.status = 402;
      throw error;
    }
  }

  if (!membershipPlan) {
    try {
      membershipPlan = await assertActiveMembershipPlan(membershipType);
    } catch {
      membershipPlan = null;
    }
  }
  const planMeta = membershipPlan
    ? resolvePlanMeta(membershipPlan)
    : MEMBERSHIP_META[membershipType];
  if (!planMeta) {
    const error = new Error('Select a valid membership plan');
    error.status = 400;
    throw error;
  }

  const planCashback = Math.max(
    0,
    Number(membershipPlan?.walletCashback?.amount ?? 0) || 0,
  );
  const envCashback = Number(
    process.env.WHATSAPP_MEMBERSHIP_CASHBACK ||
      process.env.MEMBERSHIP_WELCOME_CASHBACK ||
      0,
  );
  const safeCashback =
    planCashback > 0
      ? planCashback
      : Number.isFinite(envCashback) && envCashback > 0
        ? envCashback
        : 0;

  customer.membershipType = membershipType;
  if (membershipPlan?._id) {
    customer.membershipPlanId = membershipPlan._id;
  }
  customer.onboardingCompleted = true;
  customer.profileSetupCompleted = true;
  // Do NOT bump general walletAmount here — cashback goes to cashbackBalance via ledger
  customer.membershipPurchase = {
    orderAmount,
    discountAmount,
    paidAmount,
    couponCode,
    purchasedAt: new Date(),
    paymentOrderId: paymentOrder?._id || null,
    txnid: paymentOrder?.txnid || null,
  };

  if (couponCode) {
    if (!Array.isArray(customer.couponUsages)) customer.couponUsages = [];
    const alreadyLogged = customer.couponUsages.some(
      u =>
        String(u.code) === String(couponCode) &&
        paymentOrder &&
        customer.membershipPurchase?.txnid === paymentOrder.txnid,
    );
    // Always push once per activation attempt; rely on paymentOrder idempotency above
    if (!alreadyLogged) {
      customer.couponUsages.push({
        code: couponCode,
        discountAmount,
        orderAmount,
        membershipType,
        source: 'membership',
        usedAt: new Date(),
      });
    }
  }

  await customer.save();

  // Always create/link a Subscription row so Admin Subscription screen stays in sync
  try {
    await ensureSubscriptionForMembership({
      customer,
      membershipType,
      membershipPlan,
      orderAmount,
      discountAmount,
      paidAmount,
      couponCode,
      paymentOrder,
      createdBy: {
        m_staff_id: null,
        m_staff_name: 'Customer Portal',
        m_staff_email: null,
      },
    });
  } catch (subErr) {
    console.error(
      '[Membership] ensure Subscription row failed:',
      subErr?.message || subErr,
    );
  }

  let responseCustomer = customer;
  if (safeCashback > 0) {
    try {
      const referenceId =
        String(paymentOrder?.txnid || paymentOrder?._id || '').trim() ||
        `membership:${customer._id}:${membershipType}`;
      await creditPlanPurchaseCashback({
        customer: {
          _id: customer._id,
          name: customer.name,
          mobile: customer.mobile,
        },
        subscriptionCode: referenceId,
        amount: safeCashback,
        planName: planMeta.label || membershipType,
        createdBy: {
          m_staff_id: null,
          m_staff_name: 'Customer Portal',
          m_staff_email: null,
        },
      });
      const refreshed = await findActiveCustomer({_id: customerId});
      if (refreshed) responseCustomer = refreshed;
    } catch (walletError) {
      console.error(
        '[Membership] wallet cashback credit error:',
        walletError?.message || walletError,
      );
    }
  }

  try {
    await creditInviteReward({
      referredCustomerId: customer._id,
      orderAmount,
      paidAmount,
      sourceId: paymentOrder?.txnid || `membership:${customer._id}`,
      eventTrigger: 'membership_activate',
    });
  } catch (error) {
    console.error(
      '[Referral] Could not credit invite reward:',
      error?.message || error,
    );
  }

  if (couponCode && paymentOrder) {
    // increment after payment success
    const usageFilter = {code: couponCode, isActive: true};
    const couponDoc = await Coupon.findOne({code: couponCode});
    if (couponDoc) {
      const limit = Number(couponDoc.usageLimit);
      if (Number.isFinite(limit) && limit > 0) {
        usageFilter.usedCount = {$lt: limit};
      }
      await Coupon.findOneAndUpdate(usageFilter, {$inc: {usedCount: 1}});
    }
  } else if (couponCode && !paymentOrder) {
    const usageFilter = {code: couponCode, isActive: true};
    const couponDoc = await Coupon.findOne({code: couponCode});
    if (couponDoc) {
      const limit = Number(couponDoc.usageLimit);
      if (Number.isFinite(limit) && limit > 0) {
        usageFilter.usedCount = {$lt: limit};
      }
      await Coupon.findOneAndUpdate(usageFilter, {$inc: {usedCount: 1}});
    }
  }

  const cashbackLabel = String(safeCashback);
  let whatsapp = null;
  try {
    if (isMembershipUpgrade) {
      whatsapp = await sendMembershipChangeWhatsApp({
        to: customer.mobile,
        customerName: customer.name || 'Member',
        membershipName: planMeta.label,
        validity: planMeta.validity,
        cashbackAmount: cashbackLabel,
      });
    } else {
      whatsapp = await sendMembershipPurchaseWhatsApp({
        to: customer.mobile,
        name: customer.name || 'Member',
        membershipLabel: planMeta.label,
        validity: planMeta.validity,
        cashbackLabel,
      });
    }
  } catch (err) {
    console.error('[Membership] WhatsApp send error:', err?.message || err);
    whatsapp = {delivered: false, error: err?.message || 'WhatsApp send failed'};
  }

  return {
    customer: responseCustomer.toSafeObject(),
    cashback: safeCashback,
    pricing: {
      orderAmount,
      discountAmount,
      paidAmount,
      coupon: couponSnapshot,
    },
    whatsapp,
  };
};

export const findRefreshTokenOwner = async rawToken => {
  if (!rawToken) return null;
  const tokenHash = hashToken(rawToken);
  return CustomerRefreshToken.findOne({
    tokenHash,
    revokedAt: null,
    expiresAt: {$gt: new Date()},
  });
};

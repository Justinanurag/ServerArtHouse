import bcrypt from 'bcryptjs';
import User from '../models/auth.model.js';
import Role from '../models/role.model.js';
import Counter from '../models/counter.model.js';
import {checkOtp, sendOtpSms, sendOtpEmail} from '../utils/otp.services.js';
import {createTokenAndSetCookie} from '../utils/token.utils.js';
import {buildAuthUserResponse, toPlainUser} from '../utils/authUser.utils.js';

const SALT_ROUNDS = 12;

/** Fields staff may update on their own profile (mass-assignment allowlist). */
const PROFILE_ALLOWLIST = [
  'fullName',
  'email',
  'phoneNumber',
  'gstin',
  'companyName',
  'address',
  'pincode',
  'city',
  'state',
  'country',
  'membershipType',
  'adharNumber',
  'dob',
  'gender',
  'whatsappNumber',
  'AlternateMobile',
];

const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s).trim());

/** Accepts 10-digit local or 12-digit with 91 prefix; returns E.164 +91… or null */
const normalizePhone = input => {
  const digits = String(input ?? '').replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return null;
};

const parseLoginIdentifier = raw => {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (isEmail(s)) return {type: 'email', value: s.toLowerCase()};
  const phone = normalizePhone(s);
  if (phone) return {type: 'phone', value: phone};
  return null;
};

const getNextStaffId = async () => {
  const counter = await Counter.findOneAndUpdate(
    {key: 'm_staff_id'},
    {$inc: {value: 1}},
    {new: true, upsert: true, setDefaultsOnInsert: true},
  );
  return `STF${String(counter.value).padStart(6, '0')}`;
};

const pickProfileFields = body => {
  const src = body && typeof body === 'object' ? body : {};
  const out = {};

  for (const key of PROFILE_ALLOWLIST) {
    if (src[key] !== undefined) out[key] = src[key];
  }

  if (src.fullName === undefined && typeof src.name === 'string') {
    out.fullName = src.name;
  }
  if (src.phoneNumber === undefined && (src.mobile || src.phone)) {
    const phoneNorm = normalizePhone(src.mobile || src.phone);
    if (phoneNorm) out.phoneNumber = phoneNorm;
  }
  if (out.email) out.email = String(out.email).trim().toLowerCase();
  if (out.fullName) out.fullName = String(out.fullName).trim();

  return out;
};

/**
 * Public register is denied by default once any staff exists.
 * Override with ALLOW_PUBLIC_REGISTER=true (dev/bootstrap only).
 */
const assertPublicRegisterAllowed = async () => {
  const flag = String(process.env.ALLOW_PUBLIC_REGISTER || '')
    .trim()
    .toLowerCase();
  if (flag === 'true' || flag === '1') return {ok: true};
  if (flag === 'false' || flag === '0') {
    return {
      ok: false,
      message:
        'Public registration is disabled. Ask an administrator to create your account.',
    };
  }

  const count = await User.countDocuments();
  if (count === 0) return {ok: true};

  return {
    ok: false,
    message:
      'Public registration is disabled. Ask an administrator to create your account from Access Control.',
  };
};

const healthCheck = async (req, res) => {
  try {
    res.status(200).json({
      success: true,
      message: 'Health check successful.',
    });
  } catch (error) {
    console.error('Health check error:', error);
    return res.status(500).json({
      success: false,
      message: 'Health check error.',
    });
  }
};

const logout = async (req, res) => {
  try {
    const isProd = process.env.NODE_ENV === 'production';
    res.clearCookie('authToken', {
      httpOnly: true,
      secure: isProd,
      sameSite: 'lax',
    });
    return res.status(200).json({
      success: true,
      message: 'Logged out successfully.',
    });
  } catch (error) {
    console.error('logout error:', error);
    return res.status(500).json({
      success: false,
      message: 'Logout failed.',
    });
  }
};

const register = async (req, res) => {
  try {
    const gate = await assertPublicRegisterAllowed();
    if (!gate.ok) {
      return res.status(403).json({
        success: false,
        message: gate.message,
      });
    }

    const {fullName, email, phone, password} = req.body;

    if (!fullName || !email || !phone || !password) {
      return res.status(400).json({
        success: false,
        message: 'Name, email, phone number, and password are required.',
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters.',
      });
    }

    const emailNorm = String(email).trim().toLowerCase();
    if (!isEmail(emailNorm)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email address.',
      });
    }

    const phoneNorm = normalizePhone(phone);
    if (!phoneNorm) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number. Use 10 digits.',
      });
    }

    const exists = await User.findOne({
      $or: [{email: emailNorm}, {phoneNumber: phoneNorm}],
    });
    if (exists) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email or phone already exists.',
      });
    }

    const staffId = await getNextStaffId();
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    const userCount = await User.countDocuments();
    let roleDoc = null;
    if (userCount === 0) {
      roleDoc = await Role.findOne({slug: 'super_admin', isActive: true}).select(
        '_id',
      );
    }
    if (!roleDoc) {
      roleDoc = await Role.findOne({slug: 'viewer', isActive: true}).select('_id');
    }

    const user = await User.create({
      m_staff_id: staffId,
      fullName: String(fullName).trim(),
      email: emailNorm,
      phoneNumber: phoneNorm,
      passwordHash,
      role: userCount === 0 ? 'admin' : 'user',
      roleId: roleDoc?._id || null,
    });

    const token = createTokenAndSetCookie(res, {
      userId: user._id.toString(),
      phoneNumber: user.phoneNumber,
    });

    const authUser = await buildAuthUserResponse(user);

    return res.status(201).json({
      success: true,
      message: 'Registration successful.',
      user: authUser,
      token,
    });
  } catch (error) {
    console.error('Register error:', error);
    return res.status(500).json({
      success: false,
      message: 'Registration failed.',
    });
  }
};

const login = async (req, res) => {
  try {
    const {identifier, password} = req.body;

    if (!identifier || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email or phone and password are required.',
      });
    }

    const parsed = parseLoginIdentifier(identifier);
    if (!parsed) {
      return res.status(400).json({
        success: false,
        message: 'Enter a valid email or 10-digit phone number.',
      });
    }

    const query =
      parsed.type === 'email'
        ? {email: parsed.value}
        : {phoneNumber: parsed.value};

    const user = await User.findOne(query)
      .select('+passwordHash')
      .populate('companies')
      .populate('roleId', 'name slug permissions isActive');

    const invalidCreds = () =>
      res.status(401).json({
        success: false,
        message: 'Invalid email/phone or password.',
      });

    if (!user) {
      return invalidCreds();
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return invalidCreds();
    }

    const token = createTokenAndSetCookie(res, {
      userId: user._id.toString(),
      phoneNumber: user.phoneNumber,
      name: user.fullName,
      email: user.email,
    });

    const authUser = await buildAuthUserResponse(user);

    return res.status(200).json({
      success: true,
      message: 'Login successful.',
      user: authUser,
      token,
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({
      success: false,
      message: 'Login failed.',
    });
  }
};

const requestOtp = async (req, res) => {
  try {
    const {whatsappNumber, phoneNumber} = req.body;
    const raw = whatsappNumber ?? phoneNumber;
    if (!raw) {
      return res.status(400).json({
        success: false,
        message: 'Phone number is required.',
      });
    }
    await sendOtpSms(raw);

    res.status(200).json({
      message: 'OTP sent successfully.',
      success: true,
    });
  } catch (error) {
    console.error('requestOtp error:', error);
    return res.status(500).json({
      success: false,
      message: 'Could not send OTP.',
    });
  }
};

const verifyOtp = async (req, res) => {
  try {
    const {whatsappNumber, phoneNumber, otp} = req.body;
    const raw = whatsappNumber ?? phoneNumber;
    if (!raw || !otp) {
      return res.status(400).json({
        success: false,
        message: 'Phone number and OTP are required.',
      });
    }
    const isValid = checkOtp(raw, otp);
    if (!isValid) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired OTP.',
      });
    }

    const normalized = normalizePhone(raw);
    if (!normalized) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number.',
      });
    }

    const user = await User.findOne({phoneNumber: normalized})
      .populate('companies')
      .populate('roleId', 'name slug permissions isActive');
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found.',
      });
    }

    const token = createTokenAndSetCookie(res, {
      userId: user._id.toString(),
      phoneNumber: user.phoneNumber,
    });

    const authUser = await buildAuthUserResponse(user);

    return res.status(200).json({
      success: true,
      message: 'OTP verified successfully.',
      token,
      user: authUser,
    });
  } catch (error) {
    console.error('verifyOtp error:', error);
    return res.status(500).json({
      success: false,
      message: 'OTP verification failed.',
    });
  }
};

/** PATCH /auth/me — update the authenticated staff profile only. */
const updateMe = async (req, res) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized.',
      });
    }

    const updateData = pickProfileFields(req.body);
    if (!Object.keys(updateData).length) {
      return res.status(400).json({
        success: false,
        message: 'No valid profile fields to update.',
      });
    }

    updateData.updatedAt = new Date();

    const user = await User.findByIdAndUpdate(
      userId,
      {$set: updateData},
      {new: true, runValidators: true},
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found.',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Profile updated successfully.',
      user: toPlainUser(user),
    });
  } catch (error) {
    console.error('Update me error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update profile.',
    });
  }
};

/**
 * Legacy PATCH /auth/:mobile — requires auth; may only update own account.
 */
const updateUser = async (req, res) => {
  try {
    const {mobile} = req.params;
    const norm = normalizePhone(mobile);
    if (!norm) {
      return res.status(400).json({
        success: false,
        message: 'Invalid mobile number format.',
      });
    }

    const actorId = req.user?.userId;
    if (!actorId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized.',
      });
    }

    const actor = await User.findById(actorId).select('phoneNumber').lean();
    if (!actor) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized.',
      });
    }

    if (String(actor.phoneNumber) !== String(norm)) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden. You can only update your own profile.',
      });
    }

    const updateData = pickProfileFields(req.body);
    if (!Object.keys(updateData).length) {
      return res.status(400).json({
        success: false,
        message: 'No valid profile fields to update.',
      });
    }

    updateData.updatedAt = new Date();

    const user = await User.findOneAndUpdate(
      {_id: actorId, phoneNumber: norm},
      {$set: updateData},
      {new: true, runValidators: true},
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found.',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'User updated successfully.',
      user: toPlainUser(user),
    });
  } catch (error) {
    console.error('Update user error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update user.',
    });
  }
};

const requestEmailOtp = async (req, res) => {
  try {
    const {email} = req.body;
    if (!email || !isEmail(email)) {
      return res.status(400).json({
        success: false,
        message: 'Valid email address is required.',
      });
    }

    const emailNorm = String(email).trim().toLowerCase();
    const user = await User.findOne({email: emailNorm});

    if (user) {
      try {
        await sendOtpEmail(emailNorm);
      } catch (sendErr) {
        console.error('requestEmailOtp send error:', sendErr);
      }
    }

    return res.status(200).json({
      success: true,
      message:
        'If an account exists for that email, an OTP has been sent.',
    });
  } catch (error) {
    console.error('requestEmailOtp error:', error);
    return res.status(500).json({
      success: false,
      message: 'Could not process OTP request.',
    });
  }
};

const forgotPassword = async (req, res) => {
  try {
    const {identifier, email, phone, phoneNumber, otp, newPassword} = req.body;

    const target = identifier || email || phone || phoneNumber;

    if (!target || !otp || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Please provide email/phone, OTP, and newPassword.',
      });
    }

    if (String(newPassword).length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters.',
      });
    }

    const isValidOtp = checkOtp(target, otp);
    if (!isValidOtp) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired OTP.',
      });
    }

    const query = String(target).includes('@')
      ? {email: String(target).trim().toLowerCase()}
      : {phoneNumber: normalizePhone(target)};

    if (!query.email && !query.phoneNumber) {
      return res.status(400).json({
        success: false,
        message: 'Invalid email or phone.',
      });
    }

    const hashedPassword = await bcrypt.hash(newPassword, SALT_ROUNDS);

    const user = await User.findOneAndUpdate(
      query,
      {$set: {passwordHash: hashedPassword, updatedAt: new Date()}},
      {new: true},
    );

    if (!user) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired OTP.',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Password updated successfully.',
    });
  } catch (error) {
    console.error('Forgot password error:', error);

    return res.status(500).json({
      success: false,
      message: 'Failed to reset password.',
    });
  }
};

const checkPhone = async (req, res) => {
  try {
    const raw =
      req.body?.phoneNumber ??
      req.body?.mobile ??
      req.body?.phone ??
      req.query?.phoneNumber ??
      req.query?.mobile ??
      '';

    const phoneNorm = normalizePhone(raw);
    if (!phoneNorm) {
      return res.status(400).json({
        success: false,
        exists: false,
        available: false,
        message: 'Valid 10-digit phone number is required.',
      });
    }

    const user = await User.findOne({ phoneNumber: phoneNorm })
      .select('_id fullName phoneNumber email')
      .lean();

    if (user) {
      return res.status(200).json({
        success: true,
        exists: true,
        available: false,
        message: 'Phone number already exists.',
        user: {
          id: user._id,
          fullName: user.fullName,
          phoneNumber: user.phoneNumber,
          email: user.email,
        },
      });
    }

    return res.status(200).json({
      success: true,
      exists: false,
      available: true,
      message: 'Phone number is available.',
    });
  } catch (error) {
    console.error('checkPhone error:', error);
    return res.status(500).json({
      success: false,
      exists: false,
      available: false,
      message: 'Failed to check phone number.',
    });
  }
};

export {
  healthCheck,
  register,
  login,
  logout,
  requestOtp,
  requestEmailOtp,
  verifyOtp,
  updateMe,
  updateUser,
  forgotPassword,
  checkPhone
};

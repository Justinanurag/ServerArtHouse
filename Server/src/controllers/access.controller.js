import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import User from '../models/auth.model.js';
import Role from '../models/role.model.js';
import Counter from '../models/counter.model.js';
import {
  PERMISSION_CATALOG,
  normalizePermissionList,
  isValidPermission,
} from '../constants/permissions.js';
import {resolveUserPermissions} from '../utils/rbac.utils.js';
import {decryptPin, encryptPin} from '../utils/pinCrypto.js';

const SALT_ROUNDS = 12;

const staffProjection =
  'm_staff_id fullName email phoneNumber role roleId pinEnabled createdAt updatedAt';

const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s).trim());

const PIN_MIN_LEN = 4;
const PIN_MAX_LEN = 6;
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;

const isValidPin = (pin) => {
  const value = String(pin ?? '').trim();
  return /^\d+$/.test(value) && value.length >= PIN_MIN_LEN && value.length <= PIN_MAX_LEN;
};

const generateNumericPin = (length = 6) => {
  let pin = '';
  for (let i = 0; i < length; i += 1) {
    pin += String(Math.floor(Math.random() * 10));
  }
  // Avoid leading-zero-only awkwardness; still allow zeros inside
  if (pin[0] === '0') pin = `1${pin.slice(1)}`;
  return pin;
};

/** Ensure no other staff already uses this plaintext PIN (bcrypt compare). */
const isPinTakenByOther = async (plainPin, excludeUserId) => {
  const others = await User.find({
    pinHash: {$ne: null},
    ...(excludeUserId ? {_id: {$ne: excludeUserId}} : {}),
  })
    .select('+pinHash')
    .lean();

  for (const other of others) {
    if (!other.pinHash) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await bcrypt.compare(plainPin, other.pinHash)) return true;
  }
  return false;
};

const allocateUniquePin = async (excludeUserId, preferredPin = '') => {
  if (preferredPin) {
    if (await isPinTakenByOther(preferredPin, excludeUserId)) {
      const err = new Error('PIN_TAKEN');
      throw err;
    }
    return preferredPin;
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidate = generateNumericPin(6);
    // eslint-disable-next-line no-await-in-loop
    if (!(await isPinTakenByOther(candidate, excludeUserId))) {
      return candidate;
    }
  }
  const err = new Error('PIN_ALLOC_FAILED');
  throw err;
};

const normalizePhone = input => {
  const digits = String(input ?? '').replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
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

/**
 * Persist only PIN-related fields (and backfill m_staff_id if needed).
 * Avoids full-document validation failing on legacy incomplete User rows.
 */
const persistStaffPinUpdate = async (staff, patch) => {
  const set = {
    ...patch,
    updatedAt: new Date(),
  };
  if (!staff.m_staff_id) {
    set.m_staff_id = await getNextStaffId();
    staff.m_staff_id = set.m_staff_id;
  }

  await User.updateOne({_id: staff._id}, {$set: set});

  Object.assign(staff, set);
  return staff;
};

const toStaffDto = async (userDoc) => {
  const populated =
    userDoc?.roleId && typeof userDoc.roleId === 'object' && userDoc.roleId?.name
      ? userDoc
      : await User.findById(userDoc._id)
          .select(staffProjection)
          .select('+pinHash +pinEncrypted')
          .populate('roleId', 'name slug permissions isSystem isActive')
          .lean();

  const permissions = await resolveUserPermissions(populated);

  return {
    _id: populated._id,
    m_staff_id: populated.m_staff_id,
    fullName: populated.fullName,
    email: populated.email,
    phoneNumber: populated.phoneNumber,
    legacyRole: populated.role,
    pinEnabled: Boolean(populated.pinEnabled),
    pinSet: Boolean(populated.pinHash),
    /** true when admin can reveal PIN via View PIN */
    pinViewable: Boolean(populated.pinEncrypted),
    role: populated.roleId
      ? {
          id: String(populated.roleId._id),
          name: populated.roleId.name,
          slug: populated.roleId.slug,
          isSystem: populated.roleId.isSystem,
          permissionCount: Array.isArray(populated.roleId.permissions)
            ? populated.roleId.permissions.length
            : 0,
        }
      : null,
    permissionCount: permissions.length,
  };
};

/**
 * GET /access/permissions — catalog for Access UI.
 */
export const listPermissionCatalog = async (_req, res) => {
  return res.status(200).json({
    success: true,
    permissions: PERMISSION_CATALOG,
  });
};

/**
 * GET /access/roles
 */
export const listRoles = async (req, res) => {
  try {
    const roles = await Role.find({isActive: true})
      .sort({isSystem: -1, name: 1})
      .lean();

    const withCounts = roles.map(role => ({
      ...role,
      permissionCount: Array.isArray(role.permissions) ? role.permissions.length : 0,
    }));

    return res.status(200).json({success: true, roles: withCounts});
  } catch (error) {
    console.error('listRoles error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to load roles.',
    });
  }
};

/**
 * GET /access/roles/:id
 */
export const getRoleById = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid role id.'});
    }

    const role = await Role.findById(id).lean();
    if (!role || role.isActive === false) {
      return res.status(404).json({success: false, message: 'Role not found.'});
    }

    return res.status(200).json({success: true, role});
  } catch (error) {
    console.error('getRoleById error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to load role.',
    });
  }
};

/**
 * PATCH /access/roles/:id
 * Body: { name?, description?, permissions? }
 * System roles: permissions/description editable; slug locked.
 */
export const updateRole = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid role id.'});
    }

    const role = await Role.findById(id);
    if (!role || role.isActive === false) {
      return res.status(404).json({success: false, message: 'Role not found.'});
    }

    const {name, description, permissions} = req.body || {};

    if (typeof name === 'string' && name.trim()) {
      role.name = name.trim();
    }
    if (typeof description === 'string') {
      role.description = description.trim();
    }
    if (Array.isArray(permissions)) {
      role.permissions = normalizePermissionList(
        permissions.filter(p => isValidPermission(String(p || '').trim())),
      );
    }

    await role.save();

    return res.status(200).json({
      success: true,
      message: 'Role updated.',
      role: role.toObject(),
    });
  } catch (error) {
    console.error('updateRole error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update role.',
    });
  }
};

/**
 * GET /access/staff?search=
 */
export const listStaff = async (req, res) => {
  try {
    const search = String(req.query.search || '').trim();
    const filter = {};

    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [
        {fullName: rx},
        {email: rx},
        {phoneNumber: rx},
        {m_staff_id: rx},
      ];
    }

    const staff = await User.find(filter)
      .select(staffProjection)
      .select('+pinHash +pinEncrypted')
      .populate('roleId', 'name slug permissions isSystem isActive')
      .sort({createdAt: -1})
      .lean();

    const rows = await Promise.all(
      staff.map(async user => {
        const permissions = await resolveUserPermissions(user);
        return {
          _id: user._id,
          m_staff_id: user.m_staff_id,
          fullName: user.fullName,
          email: user.email,
          phoneNumber: user.phoneNumber,
          legacyRole: user.role,
          pinEnabled: Boolean(user.pinEnabled),
          pinSet: Boolean(user.pinHash),
          pinViewable: Boolean(user.pinEncrypted),
          role: user.roleId
            ? {
                id: String(user.roleId._id),
                name: user.roleId.name,
                slug: user.roleId.slug,
                isSystem: user.roleId.isSystem,
                permissionCount: Array.isArray(user.roleId.permissions)
                  ? user.roleId.permissions.length
                  : 0,
              }
            : null,
          permissionCount: permissions.length,
          createdAt: user.createdAt,
        };
      }),
    );

    return res.status(200).json({success: true, staff: rows});
  } catch (error) {
    console.error('listStaff error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to load staff.',
    });
  }
};

/**
 * PATCH /access/staff/:id/role
 * Body: { roleId: string | null }
 */
export const assignStaffRole = async (req, res) => {
  try {
    const {id} = req.params;
    const {roleId} = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid staff id.'});
    }

    const staff = await User.findById(id);
    if (!staff) {
      return res.status(404).json({success: false, message: 'Staff not found.'});
    }

    let nextRole = null;
    if (roleId === null || roleId === '' || roleId === undefined) {
      // Clearing role is allowed for manage users, but not for yourself
      if (String(req.user?.userId) === String(staff._id)) {
        return res.status(400).json({
          success: false,
          message: 'You cannot clear your own role (would lock you out).',
        });
      }
      staff.roleId = null;
    } else {
      if (!mongoose.Types.ObjectId.isValid(roleId)) {
        return res.status(400).json({success: false, message: 'Invalid role id.'});
      }
      nextRole = await Role.findOne({_id: roleId, isActive: true});
      if (!nextRole) {
        return res.status(404).json({success: false, message: 'Role not found.'});
      }

      // Prevent self lock-out: assigning yourself a role without access.manage
      if (String(req.user?.userId) === String(staff._id)) {
        const nextPerms = normalizePermissionList(nextRole.permissions || []);
        if (!nextPerms.includes('access.manage')) {
          return res.status(400).json({
            success: false,
            message:
              'You cannot assign yourself a role without access.manage (would lock you out of Access Control).',
          });
        }
      }

      staff.roleId = nextRole._id;
      // Keep legacy string roughly aligned for older UI bits
      if (nextRole.slug === 'super_admin' || nextRole.slug === 'admin') {
        staff.role = 'admin';
      } else {
        staff.role = 'user';
      }
    }

    staff.updatedAt = new Date();
    await staff.save();

    const populated = await User.findById(staff._id)
      .select(staffProjection)
      .populate('roleId', 'name slug permissions isSystem isActive')
      .lean();

    const permissions = await resolveUserPermissions(populated);

    return res.status(200).json({
      success: true,
      message: 'Role assigned.',
      staff: {
        _id: populated._id,
        m_staff_id: populated.m_staff_id,
        fullName: populated.fullName,
        email: populated.email,
        phoneNumber: populated.phoneNumber,
        legacyRole: populated.role,
        role: populated.roleId
          ? {
              id: String(populated.roleId._id),
              name: populated.roleId.name,
              slug: populated.roleId.slug,
              isSystem: populated.roleId.isSystem,
              permissionCount: Array.isArray(populated.roleId.permissions)
                ? populated.roleId.permissions.length
                : 0,
            }
          : null,
        permissionCount: permissions.length,
      },
    });
  } catch (error) {
    console.error('assignStaffRole error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to assign role.',
    });
  }
};

/**
 * POST /access/staff
 * Admin-provisioned account (replaces open public register).
 * Body: { fullName, email, phone, password, roleId? }
 */
export const createStaff = async (req, res) => {
  try {
    const {fullName, email, phone, password, roleId} = req.body || {};

    if (!fullName || !email || !phone || !password) {
      return res.status(400).json({
        success: false,
        message: 'Name, email, phone, and password are required.',
      });
    }

    if (String(password).length < 8) {
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

    let roleDoc = null;
    if (roleId) {
      if (!mongoose.Types.ObjectId.isValid(roleId)) {
        return res.status(400).json({success: false, message: 'Invalid role id.'});
      }
      roleDoc = await Role.findOne({_id: roleId, isActive: true});
      if (!roleDoc) {
        return res.status(404).json({success: false, message: 'Role not found.'});
      }
    } else {
      roleDoc = await Role.findOne({slug: 'viewer', isActive: true});
    }

    const staffId = await getNextStaffId();
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const isAdminLike =
      roleDoc?.slug === 'super_admin' || roleDoc?.slug === 'admin';

    const created = await User.create({
      m_staff_id: staffId,
      fullName: String(fullName).trim(),
      email: emailNorm,
      phoneNumber: phoneNorm,
      passwordHash,
      role: isAdminLike ? 'admin' : 'user',
      roleId: roleDoc?._id || null,
    });

    const populated = await User.findById(created._id)
      .select(staffProjection)
      .populate('roleId', 'name slug permissions isSystem isActive')
      .lean();

    return res.status(201).json({
      success: true,
      message: 'Staff account created.',
      staff: await toStaffDto(populated),
    });
  } catch (error) {
    console.error('createStaff error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to create staff account.',
    });
  }
};

/**
 * PATCH /access/staff/:id
 * Body: { fullName?, email?, phone?, password?, roleId? }
 * Password is optional — omit to keep current password.
 */
export const updateStaff = async (req, res) => {
  try {
    const {id} = req.params;
    const {fullName, email, phone, password, roleId} = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid staff id.'});
    }

    const staff = await User.findById(id);
    if (!staff) {
      return res.status(404).json({success: false, message: 'Staff not found.'});
    }

    if (fullName !== undefined) {
      const name = String(fullName || '').trim();
      if (!name) {
        return res.status(400).json({
          success: false,
          message: 'Name is required.',
        });
      }
      staff.fullName = name;
    }

    if (email !== undefined) {
      const emailNorm = String(email).trim().toLowerCase();
      if (!isEmail(emailNorm)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid email address.',
        });
      }
      const emailTaken = await User.findOne({
        email: emailNorm,
        _id: {$ne: staff._id},
      });
      if (emailTaken) {
        return res.status(409).json({
          success: false,
          message: 'Another account already uses this email.',
        });
      }
      staff.email = emailNorm;
    }

    if (phone !== undefined) {
      const phoneNorm = normalizePhone(phone);
      if (!phoneNorm) {
        return res.status(400).json({
          success: false,
          message: 'Invalid phone number. Use 10 digits.',
        });
      }
      const phoneTaken = await User.findOne({
        phoneNumber: phoneNorm,
        _id: {$ne: staff._id},
      });
      if (phoneTaken) {
        return res.status(409).json({
          success: false,
          message: 'Another account already uses this phone.',
        });
      }
      staff.phoneNumber = phoneNorm;
    }

    if (password !== undefined && String(password).trim() !== '') {
      if (String(password).length < 8) {
        return res.status(400).json({
          success: false,
          message: 'Password must be at least 8 characters.',
        });
      }
      staff.passwordHash = await bcrypt.hash(String(password), SALT_ROUNDS);
    }

    if (roleId !== undefined) {
      if (roleId === null || roleId === '') {
        if (String(req.user?.userId) === String(staff._id)) {
          return res.status(400).json({
            success: false,
            message: 'You cannot clear your own role (would lock you out).',
          });
        }
        staff.roleId = null;
        staff.role = 'user';
      } else {
        if (!mongoose.Types.ObjectId.isValid(roleId)) {
          return res
            .status(400)
            .json({success: false, message: 'Invalid role id.'});
        }
        const nextRole = await Role.findOne({_id: roleId, isActive: true});
        if (!nextRole) {
          return res
            .status(404)
            .json({success: false, message: 'Role not found.'});
        }
        if (String(req.user?.userId) === String(staff._id)) {
          const nextPerms = normalizePermissionList(nextRole.permissions || []);
          if (!nextPerms.includes('access.manage')) {
            return res.status(400).json({
              success: false,
              message:
                'You cannot assign yourself a role without access.manage.',
            });
          }
        }
        staff.roleId = nextRole._id;
        staff.role =
          nextRole.slug === 'super_admin' || nextRole.slug === 'admin'
            ? 'admin'
            : 'user';
      }
    }

    staff.updatedAt = new Date();
    await staff.save();

    return res.status(200).json({
      success: true,
      message: 'Staff updated.',
      staff: await toStaffDto(staff),
    });
  } catch (error) {
    console.error('updateStaff error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update staff.',
    });
  }
};

/**
 * DELETE /access/staff/:id
 */
export const deleteStaff = async (req, res) => {
  try {
    const {id} = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid staff id.'});
    }

    if (String(req.user?.userId) === String(id)) {
      return res.status(400).json({
        success: false,
        message: 'You cannot delete your own account.',
      });
    }

    const staff = await User.findById(id);
    if (!staff) {
      return res.status(404).json({success: false, message: 'Staff not found.'});
    }

    await User.findByIdAndDelete(id);

    return res.status(200).json({
      success: true,
      message: 'Staff deleted.',
      staffId: id,
    });
  } catch (error) {
    console.error('deleteStaff error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to delete staff.',
    });
  }
};

/**
 * POST /access/staff/:id/pin
 * Generate (or set) a Staff PIN. Returns plaintext PIN; also stores encrypted copy for View PIN.
 * Body: { pin?: string } — omit to auto-generate a 6-digit PIN.
 */
export const setStaffPin = async (req, res) => {
  try {
    const {id} = req.params;
    const {pin: rawPin} = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid staff id.'});
    }

    const staff = await User.findById(id).select('+pinHash +pinEncrypted');
    if (!staff) {
      return res.status(404).json({success: false, message: 'Staff not found.'});
    }

    let plainPin = String(rawPin ?? '').trim();
    if (plainPin && !isValidPin(plainPin)) {
      return res.status(400).json({
        success: false,
        message: `PIN must be ${PIN_MIN_LEN}-${PIN_MAX_LEN} digits.`,
      });
    }
    try {
      plainPin = await allocateUniquePin(staff._id, plainPin);
    } catch (allocErr) {
      if (allocErr?.message === 'PIN_TAKEN') {
        return res.status(409).json({
          success: false,
          message: 'This PIN is already assigned to another staff member.',
        });
      }
      return res.status(500).json({
        success: false,
        message: 'Could not generate a unique Staff PIN. Try again.',
      });
    }
    if (!isValidPin(plainPin)) {
      return res.status(400).json({
        success: false,
        message: `PIN must be ${PIN_MIN_LEN}-${PIN_MAX_LEN} digits.`,
      });
    }

    staff.pinHash = await bcrypt.hash(plainPin, SALT_ROUNDS);
    staff.pinEncrypted = encryptPin(plainPin);
    staff.pinEnabled = true;
    staff.pinFailedAttempts = 0;
    staff.pinLockedUntil = null;
    await persistStaffPinUpdate(staff, {
      pinHash: staff.pinHash,
      pinEncrypted: staff.pinEncrypted,
      pinEnabled: true,
      pinFailedAttempts: 0,
      pinLockedUntil: null,
    });

    return res.status(200).json({
      success: true,
      message: 'Staff PIN set. You can view it anytime from Access → View PIN.',
      pin: plainPin,
      staff: await toStaffDto(staff),
    });
  } catch (error) {
    console.error('setStaffPin error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to set staff PIN.',
    });
  }
};

/**
 * PATCH /access/staff/:id/pin
 * Body: { enabled?: boolean, reset?: boolean, pin?: string }
 */
export const updateStaffPin = async (req, res) => {
  try {
    const {id} = req.params;
    const {enabled, reset, pin: rawPin} = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid staff id.'});
    }

    const staff = await User.findById(id).select(
      '+pinHash +pinEncrypted +pinFailedAttempts +pinLockedUntil',
    );
    if (!staff) {
      return res.status(404).json({success: false, message: 'Staff not found.'});
    }

    let plainPin = null;

    if (reset === true || (rawPin !== undefined && String(rawPin).trim() !== '')) {
      const preferred =
        rawPin !== undefined && String(rawPin).trim() !== ''
          ? String(rawPin).trim()
          : '';
      if (preferred && !isValidPin(preferred)) {
        return res.status(400).json({
          success: false,
          message: `PIN must be ${PIN_MIN_LEN}-${PIN_MAX_LEN} digits.`,
        });
      }
      try {
        plainPin = await allocateUniquePin(staff._id, preferred);
      } catch (allocErr) {
        if (allocErr?.message === 'PIN_TAKEN') {
          return res.status(409).json({
            success: false,
            message: 'This PIN is already assigned to another staff member.',
          });
        }
        return res.status(500).json({
          success: false,
          message: 'Could not generate a unique Staff PIN. Try again.',
        });
      }
      staff.pinHash = await bcrypt.hash(plainPin, SALT_ROUNDS);
      staff.pinEncrypted = encryptPin(plainPin);
      staff.pinEnabled = true;
      staff.pinFailedAttempts = 0;
      staff.pinLockedUntil = null;
    }

    if (enabled !== undefined) {
      const nextEnabled = Boolean(enabled);
      if (nextEnabled && !staff.pinHash) {
        return res.status(400).json({
          success: false,
          message: 'Generate a PIN before enabling it.',
        });
      }
      staff.pinEnabled = nextEnabled;
      if (!nextEnabled) {
        staff.pinFailedAttempts = 0;
        staff.pinLockedUntil = null;
      }
    }

    await persistStaffPinUpdate(staff, {
      pinHash: staff.pinHash ?? null,
      pinEncrypted: staff.pinEncrypted ?? null,
      pinEnabled: Boolean(staff.pinEnabled),
      pinFailedAttempts: staff.pinFailedAttempts ?? 0,
      pinLockedUntil: staff.pinLockedUntil ?? null,
    });

    return res.status(200).json({
      success: true,
      message: plainPin
        ? 'Staff PIN updated. You can view it anytime from Access → View PIN.'
        : 'Staff PIN settings updated.',
      ...(plainPin ? {pin: plainPin} : {}),
      staff: await toStaffDto(staff),
    });
  } catch (error) {
    console.error('updateStaffPin error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update staff PIN.',
    });
  }
};

/**
 * DELETE /access/staff/:id/pin — clear PIN (disable + remove hash).
 */
export const clearStaffPin = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid staff id.'});
    }

    const staff = await User.findById(id).select('+pinHash +pinEncrypted');
    if (!staff) {
      return res.status(404).json({success: false, message: 'Staff not found.'});
    }

    staff.pinHash = null;
    staff.pinEncrypted = null;
    staff.pinEnabled = false;
    staff.pinFailedAttempts = 0;
    staff.pinLockedUntil = null;
    await persistStaffPinUpdate(staff, {
      pinHash: null,
      pinEncrypted: null,
      pinEnabled: false,
      pinFailedAttempts: 0,
      pinLockedUntil: null,
    });

    return res.status(200).json({
      success: true,
      message: 'Staff PIN cleared.',
      staff: await toStaffDto(staff),
    });
  } catch (error) {
    console.error('clearStaffPin error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to clear staff PIN.',
    });
  }
};

/**
 * GET /access/staff/:id/pin
 * Reveal Staff PIN for Access managers (decrypts pinEncrypted).
 */
export const viewStaffPin = async (req, res) => {
  try {
    const {id} = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({success: false, message: 'Invalid staff id.'});
    }

    const staff = await User.findById(id)
      .select('+pinHash +pinEncrypted fullName m_staff_id')
      .lean();
    if (!staff) {
      return res.status(404).json({success: false, message: 'Staff not found.'});
    }
    if (!staff.pinHash) {
      return res.status(404).json({
        success: false,
        message: 'No Staff PIN is set for this user.',
      });
    }
    if (!staff.pinEncrypted) {
      return res.status(409).json({
        success: false,
        message:
          'This PIN was set before View PIN was available. Use Reset or Change PIN once, then you can view it.',
        needsReset: true,
      });
    }

    const pin = decryptPin(staff.pinEncrypted);
    if (!pin || !isValidPin(pin)) {
      return res.status(409).json({
        success: false,
        message:
          'Could not decrypt this PIN. Use Reset or Change PIN once, then you can view it.',
        needsReset: true,
      });
    }

    return res.status(200).json({
      success: true,
      pin,
      staff: {
        _id: staff._id,
        fullName: staff.fullName,
        m_staff_id: staff.m_staff_id,
      },
    });
  } catch (error) {
    console.error('viewStaffPin error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to view staff PIN.',
    });
  }
};

/**
 * POST /access/staff/verify-pin
 * Body: { pin: string }
 * Verifies Staff PIN and returns staff details (never the PIN).
 */
export const verifyStaffPin = async (req, res) => {
  try {
    const pin = String(req.body?.pin ?? '').trim();
    if (!isValidPin(pin)) {
      return res.status(400).json({
        success: false,
        message: `PIN must be ${PIN_MIN_LEN}-${PIN_MAX_LEN} digits.`,
      });
    }

    const candidates = await User.find({
      pinEnabled: true,
      pinHash: {$ne: null},
    })
      .select('+pinHash +pinFailedAttempts +pinLockedUntil m_staff_id fullName email')
      .lean();

    if (!candidates.length) {
      return res.status(404).json({
        success: false,
        message: 'No staff with an active PIN found. Ask an admin to set one.',
      });
    }

    const now = Date.now();
    let matched = null;

    for (const candidate of candidates) {
      if (
        candidate.pinLockedUntil &&
        new Date(candidate.pinLockedUntil).getTime() > now
      ) {
        continue;
      }
      const ok = await bcrypt.compare(pin, candidate.pinHash);
      if (ok) {
        matched = candidate;
        break;
      }
    }

    if (!matched) {
      return res.status(400).json({
        success: false,
        message: 'Invalid Staff PIN.',
      });
    }

    await User.updateOne(
      {_id: matched._id},
      {$set: {pinFailedAttempts: 0, pinLockedUntil: null}},
    );

    return res.status(200).json({
      success: true,
      message: 'Staff verified.',
      staff: {
        _id: matched._id,
        staffId: matched._id,
        name: matched.fullName,
        staffName: matched.fullName,
        employeeId: matched.m_staff_id,
        m_staff_id: matched.m_staff_id,
        email: matched.email,
      },
      verifiedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('verifyStaffPin error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to verify Staff PIN.',
    });
  }
};

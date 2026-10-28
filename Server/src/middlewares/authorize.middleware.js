import User from '../models/auth.model.js';
import {hasAllPermissions, hasAnyPermission} from '../constants/permissions.js';
import {resolveUserPermissions} from '../utils/rbac.utils.js';


export const attachStaffContext = async (req, res, next) => {
  try {
    if (!req.user?.userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized. Invalid auth context.',
      });
    }

    const staff = await User.findById(req.user.userId)
      .select('-passwordHash')//exclude password
      .populate('roleId', 'name slug permissions isActive')
      .lean();

    if (!staff) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized. Staff account not found.',
      });
    }

    const permissions = await resolveUserPermissions(staff);

    req.staff = staff;
    req.permissions = permissions;
    req.user = {
      ...req.user,
      staffId: String(staff._id),
      m_staff_id: staff.m_staff_id,
      name: staff.fullName,
      email: staff.email,
      role: staff.role,
      roleId: staff.roleId?._id || staff.roleId || null,
      permissions,
    };

    return next();
  } catch (error) {
    console.error('attachStaffContext error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to load staff authorization context.',
    });
  }
};


export const requirePermission = (...required) => {
  const needed = required.filter(Boolean);

  return (req, res, next) => {
    if (!req.user?.userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized. Authentication required.',
      });
    }

    const userPermissions = Array.isArray(req.permissions) ? req.permissions : [];

    if (!hasAllPermissions(userPermissions, needed)) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden. You do not have permission to perform this action.',
        required: needed,
      });
    }

    return next();
  };
};

/**
 * Require ANY one of the listed permissions.
 */
export const requireAnyPermission = (...required) => {
  const needed = required.filter(Boolean);

  return (req, res, next) => {
    if (!req.user?.userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized. Authentication required.',
      });
    }

    const userPermissions = Array.isArray(req.permissions) ? req.permissions : [];

    if (!hasAnyPermission(userPermissions, needed)) {
      return res.status(403).json({
        success: false,
        message: 'Forbidden. You do not have permission to perform this action.',
        requiredAny: needed,
      });
    }

    return next();
  };
};


export const permit = (...required) => [
  attachStaffContext,
  requirePermission(...required),
];

export const permitAny = (...required) => [
  attachStaffContext,
  requireAnyPermission(...required),
];

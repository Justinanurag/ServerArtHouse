import Role from '../models/role.model.js';
import {ALL_PERMISSIONS, isValidPermission, normalizePermissionList} from '../constants/permissions.js';


export const resolveUserPermissions = async user => {
  if (!user) return [];

  const roleId = user.roleId?._id || user.roleId;
  if (roleId) {
    const roleDoc =
      user.roleId?.permissions && Array.isArray(user.roleId.permissions)
        ? user.roleId
        : await Role.findById(roleId).select('permissions slug name isActive').lean();

    if (roleDoc && roleDoc.isActive !== false) {
      return normalizePermissionList(roleDoc.permissions || []);
    }
  }

  // Temporary bootstrap: legacy admin string gets full access until roles are assigned
  if (String(user.role || '').toLowerCase() === 'admin') {
    return [...ALL_PERMISSIONS];
  }

  return [];
};

export const sanitizePermissions = (permissions = []) =>
  normalizePermissionList(permissions).filter(isValidPermission);

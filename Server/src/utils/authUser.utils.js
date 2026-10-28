/**
 * Auth helpers for attaching RBAC role + permissions to API user payloads.
 */
import Role from '../models/role.model.js';
import {resolveUserPermissions} from '../utils/rbac.utils.js';

const toPlainUser = doc => {
  const o = doc.toObject ? doc.toObject() : {...doc};
  delete o.passwordHash;
  return o;
};

/**
 * Build the staff user object returned on login / register / OTP.
 * Includes:
 * - legacy role string
 * - roleId
 * - rbacRole { id, name, slug }
 * - permissions / access_module (same list — Client uses access_module)
 */
export const buildAuthUserResponse = async userDoc => {
  const plain = toPlainUser(userDoc);

  // Prefer already-populated role; otherwise fetch lean role for response
  let roleDoc = null;
  if (plain.roleId && typeof plain.roleId === 'object' && plain.roleId.permissions) {
    roleDoc = plain.roleId;
  } else if (plain.roleId) {
    roleDoc = await Role.findById(plain.roleId)
      .select('name slug permissions isActive')
      .lean();
  }

  const permissions = await resolveUserPermissions({
    ...plain,
    roleId: roleDoc || plain.roleId,
  });

  // Don't leak nested mongoose role document fields awkwardly
  const roleId =
    roleDoc?._id?.toString?.() ||
    plain.roleId?._id?.toString?.() ||
    plain.roleId?.toString?.() ||
    null;

  return {
    ...plain,
    roleId,
    rbacRole: roleDoc
      ? {
          id: String(roleDoc._id),
          name: roleDoc.name,
          slug: roleDoc.slug,
        }
      : null,
    permissions,
    // Alias used by existing Client Redux field
    access_module: permissions,
  };
};

export {toPlainUser};

import Permission from '../models/permission.model.js';
import Role from '../models/role.model.js';
import User from '../models/auth.model.js';
import {PERMISSION_CATALOG, normalizePermissionList} from '../constants/permissions.js';
import {DEFAULT_ROLES} from '../constants/defaultRoles.js';

/**
 * Upsert all catalog permissions into MongoDB.
 */
export const seedPermissions = async () => {
  let upserted = 0;

  for (const item of PERMISSION_CATALOG) {
    await Permission.updateOne(
      {key: item.key},
      {
        $set: {
          key: item.key,
          label: item.label,
          module: item.module,
          description: item.label,
          isActive: true,
        },
      },
      {upsert: true},
    );
    upserted += 1;
  }

  return {permissionCount: upserted};
};

/**
 * Upsert default system roles.
 */
export const seedRoles = async () => {
  const results = [];

  for (const role of DEFAULT_ROLES) {
    const permissions = normalizePermissionList(role.permissions);
    const doc = await Role.findOneAndUpdate(
      {slug: role.slug},
      {
        $set: {
          name: role.name,
          slug: role.slug,
          description: role.description,
          permissions,
          isSystem: role.isSystem === true,
          isActive: true,
        },
      },
      {upsert: true, new: true},
    );
    results.push({
      slug: doc.slug,
      name: doc.name,
      permissionCount: (doc.permissions || []).length,
    });
  }

  return {roles: results};
};

/**
 * Assign Super Admin role to legacy staff with role === 'admin' and no roleId.
 */
export const assignSuperAdminToLegacyAdmins = async () => {
  const superAdmin = await Role.findOne({slug: 'super_admin', isActive: true});
  if (!superAdmin) {
    return {assigned: 0, message: 'super_admin role not found'};
  }

  const result = await User.updateMany(
    {
      role: 'admin',
      $or: [{roleId: null}, {roleId: {$exists: false}}],
    },
    {$set: {roleId: superAdmin._id}},
  );

  return {
    assigned: result.modifiedCount || 0,
    superAdminRoleId: String(superAdmin._id),
  };
};

/**
 * Full RBAC seed: permissions → roles → legacy admin assignment.
 */
export const seedRbac = async ({assignLegacyAdmins = true} = {}) => {
  const permissions = await seedPermissions();
  const roles = await seedRoles();
  const assignment = assignLegacyAdmins
    ? await assignSuperAdminToLegacyAdmins()
    : {assigned: 0, skipped: true};

  return {
    success: true,
    permissions,
    roles,
    assignment,
  };
};

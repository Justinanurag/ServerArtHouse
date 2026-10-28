/**
 * Seed RBAC permissions + default roles.
 *
 * Usage (from Server folder):
 *   node scripts/seedRbac.js
 *   npm run seed:rbac
 */
import path from 'path';
import {fileURLToPath} from 'url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import {seedRbac} from '../src/services/rbacSeed.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({path: path.join(__dirname, '../src/.env')});

const run = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('❌ MONGODB_URI missing in Server/src/.env');
    process.exit(1);
  }

  try {
    console.log('⏳ Connecting to MongoDB...');
    await mongoose.connect(uri);
    console.log('✅ Connected');

    const result = await seedRbac({assignLegacyAdmins: true});

    console.log('\n📦 Permissions upserted:', result.permissions.permissionCount);
    console.log('👥 Roles:');
    for (const role of result.roles.roles) {
      console.log(
        `   - ${role.name} (${role.slug}) → ${role.permissionCount} permissions`,
      );
    }
    console.log(
      '🔗 Legacy admins assigned to super_admin:',
      result.assignment.assigned,
    );
    console.log('\n✅ RBAC seed completed successfully.');
  } catch (error) {
    console.error('❌ RBAC seed failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
};

run();

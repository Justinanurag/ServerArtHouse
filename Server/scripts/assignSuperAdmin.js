import dotenv from 'dotenv';
import path from 'path';
import {fileURLToPath} from 'url';
import mongoose from 'mongoose';
import User from '../src/models/auth.model.js';
import Role from '../src/models/role.model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({path: path.join(__dirname, '../src/.env')});

const emails = ['justinanurag0.3@gmail.com', 'justinanurag0.2@gmail.com'];

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);

  const superAdmin = await Role.findOne({slug: 'super_admin', isActive: true});
  if (!superAdmin) {
    console.error('super_admin role missing — run: npm run seed:rbac');
    process.exit(1);
  }

  const result = await User.updateMany(
    {email: {$in: emails}},
    {$set: {roleId: superAdmin._id, role: 'admin'}},
  );

  const updated = await User.find({email: {$in: emails}})
    .select('fullName email role roleId')
    .populate('roleId', 'name slug')
    .lean();

  console.log(`matched=${result.matchedCount} modified=${result.modifiedCount}`);
  for (const u of updated) {
    console.log({
      name: u.fullName,
      email: u.email,
      legacy: u.role,
      rbac: u.roleId?.slug,
      roleName: u.roleId?.name,
    });
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

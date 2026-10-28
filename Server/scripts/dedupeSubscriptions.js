/**
 * Remove duplicate subscriptions created by accidental re-uploads.
 *
 * Duplicate key:
 *   customerPhone + membershipType + membershipPlanId + startDate(day) + endDate(day) + grandTotal
 *
 * Keeps the oldest document in each group; deletes the rest.
 *
 * Usage (from Server folder):
 *   node scripts/dedupeSubscriptions.js --dry-run
 *   node scripts/dedupeSubscriptions.js --execute
 */
import path from 'path';
import {fileURLToPath} from 'url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Subscription from '../src/models/subscription.model.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({path: path.join(__dirname, '../src/.env')});

const args = new Set(process.argv.slice(2));
const dryRun = !args.has('--execute');

const dayKey = value => {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().slice(0, 10);
};

const run = async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('❌ MONGODB_URI missing in Server/src/.env');
    process.exit(1);
  }

  console.log(dryRun ? '🔎 DRY RUN (no deletes)' : '🧹 EXECUTE (will delete duplicates)');
  console.log('⏳ Connecting to MongoDB...');
  await mongoose.connect(uri);
  console.log('✅ Connected');

  const totalBefore = await Subscription.countDocuments({});
  console.log(`📊 Subscriptions before: ${totalBefore}`);

  const groups = await Subscription.aggregate([
    {
      $addFields: {
        _startDay: {
          $dateToString: {
            format: '%Y-%m-%d',
            date: {$ifNull: ['$startDate', '$invoiceDate']},
          },
        },
        _endDay: {
          $dateToString: {
            format: '%Y-%m-%d',
            date: {$ifNull: ['$endDate', '$dueDate']},
          },
        },
        _phone: {
          $trim: {input: {$toString: {$ifNull: ['$customerPhone', '']}}},
        },
        _membershipType: {
          $toLower: {
            $trim: {input: {$toString: {$ifNull: ['$membershipType', '']}}},
          },
        },
        _planId: {
          $toLower: {
            $trim: {
              input: {$toString: {$ifNull: ['$membershipPlanId', '']}},
            },
          },
        },
        _amount: {$ifNull: ['$grandTotal', 0]},
      },
    },
    {
      $group: {
        _id: {
          phone: '$_phone',
          membershipType: '$_membershipType',
          planId: '$_planId',
          startDay: '$_startDay',
          endDay: '$_endDay',
          amount: '$_amount',
        },
        count: {$sum: 1},
        docs: {
          $push: {
            id: '$_id',
            code: '$subscriptionCode',
            name: '$customerName',
            createdAt: '$createdAt',
          },
        },
      },
    },
    {$match: {count: {$gt: 1}}},
    {$sort: {count: -1}},
  ]);

  console.log(`🔁 Duplicate groups found: ${groups.length}`);

  let deleteIds = [];
  let keepCount = 0;

  for (const group of groups) {
    const sorted = [...group.docs].sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      if (ta !== tb) return ta - tb;
      return String(a.id).localeCompare(String(b.id));
    });
    const keep = sorted[0];
    const remove = sorted.slice(1);
    keepCount += 1;
    deleteIds.push(...remove.map(d => d.id));

    console.log(
      ` - ${group._id.phone || '(no phone)'} | ${group._id.membershipType || group._id.planId || 'plan'} | ${group._id.startDay}→${group._id.endDay} | ×${group.count}`,
    );
    console.log(
      `   keep: ${keep.code || keep.id} (${keep.name || ''})`,
    );
    console.log(
      `   delete: ${remove.map(d => d.code || d.id).join(', ')}`,
    );
  }

  console.log(`\n📌 Would keep 1 per group (${keepCount} kept)`);
  console.log(`🗑️  Duplicate rows to remove: ${deleteIds.length}`);

  if (!dryRun && deleteIds.length) {
    const result = await Subscription.deleteMany({_id: {$in: deleteIds}});
    console.log(`✅ Deleted: ${result.deletedCount}`);
  } else if (dryRun) {
    console.log('\n(No changes made. Re-run with --execute to delete.)');
  }

  const totalAfter = await Subscription.countDocuments({});
  console.log(`📊 Subscriptions after: ${totalAfter}`);
  // dayKey unused helper retained for clarity in logs if needed later
  void dayKey;

  await mongoose.disconnect();
  process.exit(0);
};

run().catch(async err => {
  console.error('❌ Dedupe failed:', err?.message || err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

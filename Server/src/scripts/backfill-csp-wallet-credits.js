/**
 * Idempotent CSP wallet credit backfill.
 * Usage:
 *   node scripts/backfill-csp-wallet-credits.js --dry-run
 *   node scripts/backfill-csp-wallet-credits.js
 *   node scripts/backfill-csp-wallet-credits.js --invoice=INVVWAH-143
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config();

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const invoiceArg = args.find(a => a.startsWith('--invoice='));
const invoiceCodes = invoiceArg
  ? [invoiceArg.split('=').slice(1).join('=')]
  : null;

await mongoose.connect(process.env.MONGODB_URI);

const {backfillMissedCspSettlements} = await import(
  '../services/cspPaymentSplit.service.js'
);

const result = await backfillMissedCspSettlements({
  dryRun,
  invoiceCodes,
});

console.log(JSON.stringify(result, null, 2));
process.exit(0);

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { Worker } from 'bullmq';
import connectDB from '../config/db.js';
import {
  ANNOUNCEMENT_QUEUE_NAME,
} from '../queue/announcement.queue.js';
import { redisConnection } from '../queue/redisConnection.js';
import Announcement from '../models/announcement.model.js';
import {
  normalizeWhatsAppTemplateName,
  sendWhatsAppTemplateMessage,
} from '../modules/customer/services/whatsapp.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Worker is in src/workers → env is Server/src/.env
dotenv.config({ path: path.join(__dirname, '../.env') });

if (!process.env.MONGODB_URI) {
  throw new Error(
    'MONGODB_URI missing. Check Server/src/.env is loaded (not src/workers/.env).',
  );
}

await connectDB();

const worker = new Worker(
  ANNOUNCEMENT_QUEUE_NAME,
  async (job) => {
    const {
      announcementId,
      phone,
      whatsappTemplateName,
      languageCode,
      templateParams,
      headerImageLink,
      headerImageId,
    } = job.data;

    // Source of truth from DB so All/Selected never drift, and normalize
    // display-like values ("new cafe") → Meta name ("newcafe").
    const announcement = announcementId
      ? await Announcement.findById(announcementId).lean()
      : null;

    const templateName = normalizeWhatsAppTemplateName(
      announcement?.whatsappMetaTemplateName || whatsappTemplateName,
    );
    const lang =
      String(announcement?.languageCode || languageCode || 'en').trim() || 'en';
    const imageLink = String(
      announcement?.headerImageLink || headerImageLink || '',
    ).trim();
    const imageId = String(
      announcement?.headerImageId || headerImageId || '',
    ).trim();
    const bodyParams = Array.isArray(announcement?.templateParams)
      ? announcement.templateParams
      : Array.isArray(templateParams)
        ? templateParams
        : [];

    await sendWhatsAppTemplateMessage({
      to: phone,
      templateName,
      languageCode: lang,
      // Only send body params the UI/API provided.
      // Static templates (e.g. newcafe) expect 0 params — do not invent values.
      bodyParams: bodyParams
        .map((p) => String(p ?? '').trim())
        .filter(Boolean),
      // IMAGE-header templates (e.g. newcafe) require image link or media id.
      headerImageLink: imageLink,
      headerImageId: imageId,
    });

    const updated = await Announcement.findByIdAndUpdate(
      announcementId,
      { $inc: { sentCount: 1 } },
      { new: true },
    );

    if (updated) {
      const done =
        updated.sentCount + updated.failedCount >= updated.totalRecipients;
      if (done) {
        updated.status =
          updated.failedCount > 0 && updated.sentCount === 0
            ? 'failed'
            : 'completed';
        updated.completedAt = new Date();
        await updated.save();
      } else if (updated.status === 'pending') {
        updated.status = 'sending';
        await updated.save();
      }
    }

    return { ok: true, phone };
  },
  {
    connection: redisConnection(),
    concurrency: 5,
    limiter: {
      max: 20,
      duration: 1000,
    },
  },
);

worker.on('failed', async (job, err) => {
  console.error('[Announcement worker] failed', job?.id, err?.message);
  const announcementId = job?.data?.announcementId;
  if (!announcementId) return;

  // Count failure only after final attempt
  if ((job.attemptsMade || 0) >= (job.opts.attempts || 1)) {
    const updated = await Announcement.findByIdAndUpdate(
      announcementId,
      {
        $inc: { failedCount: 1 },
        $set: { lastError: err?.message || 'send failed' },
      },
      { new: true },
    );

    if (updated) {
      const done =
        updated.sentCount + updated.failedCount >= updated.totalRecipients;
      if (done) {
        updated.status = updated.sentCount === 0 ? 'failed' : 'completed';
        updated.completedAt = new Date();
        await updated.save();
      }
    }
  }
});

worker.on('completed', (job) => {
  console.log('[Announcement worker] completed', job.id);
});

worker.on('error', (err) => {
  console.error('[Announcement worker] error', err?.message || err);
});

console.log(
  `Announcement worker running on queue: ${ANNOUNCEMENT_QUEUE_NAME}`,
);

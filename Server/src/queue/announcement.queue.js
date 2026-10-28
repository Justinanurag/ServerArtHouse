import { Queue } from 'bullmq';
import { redisConnection } from './redisConnection.js';

/** Same name must be used by Queue (API) and Worker */
export const ANNOUNCEMENT_QUEUE_NAME = 'announcement-whatsapp';

let _queue = null;

/** Lazy create — avoids connecting before .env is loaded */
export function getAnnouncementQueue() {
  if (_queue) return _queue;
  _queue = new Queue(ANNOUNCEMENT_QUEUE_NAME, {
    connection: redisConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });
  return _queue;
}

/**
 * One job = one WhatsApp message to one customer
 */
export async function enqueueAnnouncementRecipient(data) {
  // BullMQ custom jobId cannot contain ":" — use hyphen instead
  const jobId = `ann-${data.announcementId}-${data.customerId}`;
  return getAnnouncementQueue().add('send-one', data, { jobId });
}

// Back-compat named export (getter via lazy factory)
export const announcementQueue = {
  add: (...args) => getAnnouncementQueue().add(...args),
};

export default announcementQueue;

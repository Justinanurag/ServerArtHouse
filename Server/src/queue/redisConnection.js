import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import IORedis from 'ioredis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });

let connection = null;

export function redisConnection() {
  if (connection) return connection;

  const commonOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy(times) {
      if (times > 5) return null;
      return Math.min(times * 500, 3000);
    },
  };

  const redisUrl = process.env.REDIS_URL;

  if (redisUrl) {
    connection = new IORedis(redisUrl, commonOptions);
  } else {
    const host = process.env.REDIS_HOST || '127.0.0.1';
    const port = Number(process.env.REDIS_PORT || 6379);
    const password = process.env.REDIS_PASSWORD;
    const username = process.env.REDIS_USERNAME || undefined;
    const useTls = process.env.REDIS_TLS === 'true';

    if (!process.env.REDIS_URL && !process.env.REDIS_HOST) {
      console.warn(
        'REDIS_HOST not set — defaulting to 127.0.0.1. Set REDIS_URL or REDIS_HOST in src/.env',
      );
    }

    connection = new IORedis({
      host,
      port,
      ...(username ? { username } : {}),
      password: password || undefined,
      ...commonOptions,
      ...(useTls ? { tls: {} } : {}),
    });
  }

  connection.on('connect', () => {
    console.log('✅ Redis connected');
  });

  connection.on('error', (err) => {
    console.error('❌ Redis error:', err.message);
  });

  return connection;
}

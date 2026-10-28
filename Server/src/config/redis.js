import path from 'path';
import dotenv from 'dotenv';
import {fileURLToPath} from 'url';
import {Redis} from '@upstash/redis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Imported modules run before server.js loads env. Read src/.env here.
// Existing process env (Vercel) is left untouched; dotenv does not override it.
dotenv.config({path: path.join(__dirname, '../.env')});

let client = null;
let missingLogged = false;

const timeoutMs = () => {
  const parsed = Number(process.env.REDIS_COMMAND_TIMEOUT_MS);
  if (!Number.isFinite(parsed) || parsed < 200) return 1500;
  return Math.min(Math.trunc(parsed), 5000);
};

const safeErrorMessage = error =>
  String(error?.message || 'Redis command failed')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/Bearer\s+\S+/gi, '[token]')
    .slice(0, 300);

/**
 * One REST client per warm process. Safe for Vercel: no TCP socket,
 * and this function does not construct a client per request.
 */
export function getRedis() {
  if (client) return client;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    if (!missingLogged) {
      missingLogged = true;
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'redis_unavailable',
          message:
            'UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN is missing. Cache reads fall back to MongoDB.',
        }),
      );
    }
    return null;
  }

  client = new Redis({
    url,
    token,
    enableTelemetry: false,
    retry: {
      retries: 1,
      backoff: () => 200,
    },
  });
  return client;
}

/**
 * Run one Redis command. Returns { ok:false } on timeout or command failure
 * so callers can use MongoDB instead of failing the request.
 */
export async function runRedis(command) {
  const redis = getRedis();
  if (!redis) return {ok: false, skipped: true};

  let timer;
  try {
    const value = await Promise.race([
      command(redis),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Redis command timed out')),
          timeoutMs(),
        );
      }),
    ]);
    return {ok: true, value};
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'redis_error',
        message: safeErrorMessage(error),
      }),
    );
    return {ok: false};
  } finally {
    if (timer) clearTimeout(timer);
  }
}

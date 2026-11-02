import {runRedis} from './redis.js';

const KEY_PATTERN = /^erp:cache:[A-Za-z0-9:_-]{1,180}$/;
const SCAN_PATTERN = /^erp:cache:[A-Za-z0-9:_*?-]{1,120}$/;
const MAX_VALUE_BYTES = 750_000;
const MAX_SCAN_ROUNDS = 20;
const MAX_TTL_SECONDS = 86_400;

const log = (event, fields = {}) => {
  console.info(JSON.stringify({level: 'info', event, ...fields}));
};

const byteLength = value => {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

/**
 * Read one cache entry. Null means a miss or a Redis failure.
 * Callers must treat null as "load from MongoDB".
 */
export async function getCache(key) {
  if (!KEY_PATTERN.test(String(key || ''))) return null;

  const result = await runRedis(redis => redis.get(key));
  if (!result.ok) return null;
  if (result.value == null) {
    log('cache_miss', {key});
    return null;
  }
  log('cache_hit', {key});
  return result.value;
}

/**
 * Store a successful value. Refuses errors, failed query payloads, and oversized values.
 * Returns false when the write is skipped or Redis is unavailable.
 */
export async function setCache(key, value, ttl) {
  const cacheKey = String(key || '');
  const seconds = Number(ttl);
  if (!KEY_PATTERN.test(cacheKey)) return false;
  if (!Number.isFinite(seconds) || seconds < 1) return false;
  if (value == null) return false;
  if (typeof value === 'object' && value.success === false) return false;
  if (byteLength(value) > MAX_VALUE_BYTES) {
    log('cache_skip', {key: cacheKey, reason: 'value_too_large'});
    return false;
  }

  const result = await runRedis(redis =>
    redis.set(cacheKey, value, {ex: Math.min(Math.trunc(seconds), MAX_TTL_SECONDS)}),
  );
  if (!result.ok) return false;
  log('cache_set', {key: cacheKey, ttl: Math.min(Math.trunc(seconds), MAX_TTL_SECONDS)});
  return true;
}

export async function deleteCache(key) {
  if (!KEY_PATTERN.test(String(key || ''))) return false;
  const result = await runRedis(redis => redis.del(key));
  if (!result.ok) return false;
  log('cache_delete', {key});
  return true;
}

/**
 * Delete keys under the erp:cache namespace using cursor SCAN.
 * Refuses broad patterns such as "*" or "KEYS". Not for the request read path.
 * Stops after a fixed number of rounds so one call cannot walk the whole database.
 */
export async function deleteCacheByPattern(pattern) {
  const match = String(pattern || '');
  if (!SCAN_PATTERN.test(match) || !match.startsWith('erp:cache:')) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'redis_error',
        message: 'Refused cache delete. Pattern must stay inside erp:cache:.',
      }),
    );
    return 0;
  }

  let cursor = '0';
  let deleted = 0;
  let rounds = 0;

  do {
    const scanned = await runRedis(redis =>
      redis.scan(cursor, {match, count: 100}),
    );
    if (!scanned.ok || !Array.isArray(scanned.value)) break;

    const [next, keys] = scanned.value;
    cursor = String(next ?? '0');
    const batch = Array.isArray(keys) ? keys.filter(key => KEY_PATTERN.test(key)) : [];
    if (batch.length) {
      const removed = await runRedis(redis => redis.del(...batch));
      if (removed.ok) deleted += batch.length;
    }
    rounds += 1;
    if (rounds >= MAX_SCAN_ROUNDS && cursor !== '0') {
      log('cache_delete_pattern_truncated', {pattern: match, deleted, rounds});
      break;
    }
  } while (cursor !== '0');

  log('cache_delete_pattern', {pattern: match, deleted, rounds});
  return deleted;
}

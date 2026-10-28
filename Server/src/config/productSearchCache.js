import crypto from 'crypto';
import {deleteCache, getCache, setCache} from './cache.js';
import {runRedis} from './redis.js';

const VERSION_KEY = 'erp:cache:product-search:version';

const ttlSeconds = () => {
  const parsed = Number(process.env.PRODUCT_SEARCH_CACHE_TTL_SECONDS);
  if (!Number.isFinite(parsed) || parsed < 1) return 60;
  return Math.min(Math.trunc(parsed), 300);
};

const hashIdentity = identity =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(identity))
    .digest('hex')
    .slice(0, 32);

/**
 * Current catalogue generation. Null means Redis could not be read,
 * and the caller must skip the cache.
 */
export async function readProductSearchVersion() {
  const result = await runRedis(redis => redis.get(VERSION_KEY));
  if (!result.ok) return null;
  const version = Number(result.value ?? 0);
  return Number.isFinite(version) && version >= 0 ? Math.trunc(version) : 0;
}

/**
 * Drop every product-search entry by moving the key generation forward.
 * Old keys expire by TTL. This is one INCR, not a SCAN, so writes stay cheap.
 */
export async function invalidateProductSearchCache() {
  const result = await runRedis(redis => redis.incr(VERSION_KEY));
  if (!result.ok) return false;
  console.info(
    JSON.stringify({
      level: 'info',
      event: 'cache_invalidate',
      namespace: 'product-search',
      version: result.value,
    }),
  );
  return true;
}

/**
 * Cache-aside for a successful product search.
 * `load` runs against MongoDB on a miss or when Redis is unavailable.
 * Thrown loader errors are not cached.
 */
export async function rememberProductSearch(namespace, identity, load, accept) {
  const version = await readProductSearchVersion();
  if (version == null) return load();

  const key = `erp:cache:product-search:${namespace}:v${version}:${hashIdentity(identity)}`;
  const cached = await getCache(key);
  if (cached != null && (!accept || accept(cached))) return cached;
  if (cached != null) await deleteCache(key);

  const fresh = await load();
  if (fresh == null || (accept && !accept(fresh))) return fresh;
  await setCache(key, fresh, ttlSeconds());
  return fresh;
}

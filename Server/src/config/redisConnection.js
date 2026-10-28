import {getRedis, runRedis} from './redis.js';

/**
 * Startup ping for the Upstash REST database used by product-search cache.
 * A failure is logged and does not stop the API.
 */
export const checkRedisConnection = async () => {
  if (!getRedis()) return false;

  const result = await runRedis(redis => redis.ping());
  if (!result.ok) return false;

  console.info(
    JSON.stringify({
      level: 'info',
      event: 'redis_connected',
      ping: result.value === 'PONG' ? 'PONG' : 'ok',
    }),
  );
  return true;
};

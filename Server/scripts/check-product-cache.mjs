import {checkRedisConnection} from '../src/config/redisConnection.js';
import {
  deleteCache,
  deleteCacheByPattern,
  getCache,
  setCache,
} from '../src/config/cache.js';
import {rememberProductSearch} from '../src/config/productSearchCache.js';

const key = 'erp:cache:health:probe';

const connected = await checkRedisConnection();
if (!connected) {
  console.error('healthcheck: redis ping failed');
  process.exit(1);
}

const refused = await setCache(key, {success: false, message: 'nope'}, 30);
const wildcard = await deleteCacheByPattern('*');
const stored = await setCache(key, {ok: true, items: ['pen']}, 30);
const read = await getCache(key);
const removed = await deleteCache(key);
const afterDelete = await getCache(key);

let loads = 0;
const identity = {probe: 'product-search-health'};
const accept = value => Array.isArray(value?.items);
const first = await rememberProductSearch(
  'health',
  identity,
  async () => {
    loads += 1;
    return {items: ['paper']};
  },
  accept,
);
const second = await rememberProductSearch(
  'health',
  identity,
  async () => {
    loads += 1;
    return {items: ['paper']};
  },
  accept,
);
const cleared = await deleteCacheByPattern('erp:cache:product-search:health:*');

const pass =
  refused === false &&
  wildcard === 0 &&
  stored === true &&
  read?.ok === true &&
  Array.isArray(read.items) &&
  removed === true &&
  afterDelete == null &&
  loads === 1 &&
  first.items[0] === 'paper' &&
  second.items[0] === 'paper' &&
  cleared >= 1;

console.log(
  JSON.stringify({
    connected,
    refused,
    wildcard,
    stored,
    readOk: read?.ok === true,
    removed,
    missAfterDelete: afterDelete == null,
    loads,
    cleared,
    pass,
  }),
);

process.exit(pass ? 0 : 1);

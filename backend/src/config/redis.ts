import { Redis } from 'ioredis';
import { env } from './env';

const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  retryStrategy: (times) => {
    if (times > 3) {
      console.log('⚠️  Redis connection failed after 3 retries. Running without Redis cache.');
      return null; // Stop retrying
    }
    return Math.min(times * 100, 2000);
  },
  lazyConnect: true, // Don't connect immediately
});

redis.on('error', (err) => {
  console.error('Redis Client Error:', err.message);
  console.log('⚠️  Application will continue without Redis caching');
});

redis.on('connect', () => console.log('✅ Connected to Redis'));

// Try to connect, but don't fail if Redis is unavailable
redis.connect().catch(() => {
  console.log('⚠️  Redis is not available. Application will run without caching.');
});

export default redis;

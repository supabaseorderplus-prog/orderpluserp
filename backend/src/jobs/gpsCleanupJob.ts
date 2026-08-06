import Queue from 'bull';
import { prisma } from '../config/db';
import { env } from '../config/env';
import { logger } from '../utils/logger';

let gpsCleanupQueue: Queue.Queue | null = null;

try {
  gpsCleanupQueue = new Queue('gps-cleanup', env.REDIS_URL, {
    defaultJobOptions: { removeOnComplete: 10, removeOnFail: 5 },
  });

  gpsCleanupQueue.process(async () => {
  logger.info('[GpsCleanupJob] Archiving old GPS logs...');

  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const result = await prisma.gpsLog.deleteMany({
    where: { timestamp: { lt: ninetyDaysAgo } },
  });

  logger.info(`[GpsCleanupJob] Archived ${result.count} GPS logs older than 90 days.`);
  });
} catch (error) {
  logger.warn('[GpsCleanupJob] Failed to initialize (Redis may be unavailable):', error);
}

export function scheduleGpsCleanupJob(): void {
  if (!gpsCleanupQueue) return;
  gpsCleanupQueue.add({}, { repeat: { cron: '0 3 * * 0' } });
  logger.info('[GpsCleanupJob] Scheduled weekly on Sundays at 3 AM');
}

export { gpsCleanupQueue };

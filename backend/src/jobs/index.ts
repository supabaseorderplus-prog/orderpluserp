import { scheduleReorderJob } from './reorderJob';
import { scheduleSchemeProgressJob } from './schemeProgressJob';
import { scheduleRouteReminderJob } from './routeReminderJob';
import { scheduleGpsCleanupJob } from './gpsCleanupJob';
import { logger } from '../utils/logger';

export function initializeJobs(): void {
  try {
    scheduleReorderJob();
    scheduleSchemeProgressJob();
    scheduleRouteReminderJob();
    scheduleGpsCleanupJob();
    logger.info('All background jobs initialized');
  } catch (error) {
    logger.error('Failed to initialize background jobs:', error);
  }
}

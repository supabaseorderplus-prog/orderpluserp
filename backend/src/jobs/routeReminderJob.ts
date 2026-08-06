import Queue from 'bull';
import { prisma } from '../config/db';
import { env } from '../config/env';
import { logger } from '../utils/logger';

let routeReminderQueue: Queue.Queue | null = null;

try {
  routeReminderQueue = new Queue('route-reminder', env.REDIS_URL, {
    defaultJobOptions: { removeOnComplete: 50, removeOnFail: 20 },
  });

  routeReminderQueue.process(async () => {
  logger.info('[RouteReminderJob] Sending route briefings...');

  const today = new Date();
  const dayOfWeek = today.getDay();

  const routes = await prisma.route.findMany({
    where: {
      isActive: true,
      status: 'ACTIVE',
      OR: [
        { scheduleType: 'DAILY' },
        { scheduleType: 'WEEKLY', scheduleDays: { has: dayOfWeek } },
      ],
    },
    include: {
      salesman: { select: { id: true, name: true } },
      _count: { select: { stops: true } },
    },
  });

  let sent = 0;

  for (const route of routes) {
    await prisma.notification.create({
      data: {
        userId: route.salesman.id,
        title: `Today's Route: ${route.name}`,
        body: `You have ${route._count.stops} stops scheduled for today. Start your route when ready.`,
        type: 'SYSTEM',
        referenceId: route.id,
        referenceType: 'route',
        deliveryChannel: 'IN_APP',
      },
    });
    sent++;
  }

  logger.info(`[RouteReminderJob] Sent ${sent} route briefings.`);
  });
} catch (error) {
  logger.warn('[RouteReminderJob] Failed to initialize (Redis may be unavailable):', error);
}

export function scheduleRouteReminderJob(): void {
  if (!routeReminderQueue) return;
  routeReminderQueue.add({}, { repeat: { cron: '0 7 * * *' } });
  logger.info('[RouteReminderJob] Scheduled daily at 7 AM');
}

export { routeReminderQueue };

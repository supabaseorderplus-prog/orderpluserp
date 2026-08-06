import Queue from 'bull';
import { prisma } from '../config/db';
import { env } from '../config/env';
import { logger } from '../utils/logger';

let reorderQueue: Queue.Queue | null = null;

try {
  reorderQueue = new Queue('reorder-monitor', env.REDIS_URL, {
    defaultJobOptions: { removeOnComplete: 100, removeOnFail: 50 },
  });

  reorderQueue.process(async () => {
  logger.info('[ReorderJob] Starting reorder check...');

  const settings = await prisma.reorderSetting.findMany({
    where: { autoReorderEnabled: true, status: 'ACTIVE' },
    include: {
      retailer: true,
      product: { include: { inventory: true } },
    },
  });

  let triggersCreated = 0;

  for (const setting of settings) {
    const totalStock = setting.product.inventory.reduce(
      (sum, inv) => sum + inv.quantityOnHand - inv.quantityReserved, 0
    );

    if (totalStock <= setting.minThreshold) {
      const recentTrigger = await prisma.reorderTrigger.findFirst({
        where: {
          retailerId: setting.retailerId,
          productId: setting.productId,
          status: { in: ['PENDING', 'NOTIFIED'] },
          triggeredAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      });

      if (!recentTrigger) {
        await prisma.reorderTrigger.create({
          data: {
            retailerId: setting.retailerId,
            productId: setting.productId,
            status: 'PENDING',
          },
        });

        await prisma.notification.create({
          data: {
            userId: setting.retailerId,
            title: `Reorder Alert: ${setting.product.name}`,
            body: `Current stock: ${totalStock} units. Threshold: ${setting.minThreshold}. Consider reordering.`,
            type: 'REORDER',
            referenceId: setting.productId,
            referenceType: 'product',
            deliveryChannel: 'IN_APP',
          },
        });

        await prisma.reorderTrigger.updateMany({
          where: {
            retailerId: setting.retailerId,
            productId: setting.productId,
            status: 'PENDING',
            notificationSentAt: null,
          },
          data: { notificationSentAt: new Date(), status: 'NOTIFIED' },
        });

        triggersCreated++;
      }
    }
  }

  logger.info(`[ReorderJob] Completed. ${triggersCreated} new triggers created.`);
  });
} catch (error) {
  logger.warn('[ReorderJob] Failed to initialize (Redis may be unavailable):', error);
}

export function scheduleReorderJob(): void {
  if (!reorderQueue) return;
  reorderQueue.add({}, { repeat: { every: 10 * 60 * 1000 } });
  logger.info('[ReorderJob] Scheduled every 10 minutes');
}

export { reorderQueue };

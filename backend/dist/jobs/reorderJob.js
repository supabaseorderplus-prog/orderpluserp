"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.reorderQueue = void 0;
exports.scheduleReorderJob = scheduleReorderJob;
const bull_1 = __importDefault(require("bull"));
const db_1 = require("../config/db");
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
let reorderQueue = null;
exports.reorderQueue = reorderQueue;
try {
    exports.reorderQueue = reorderQueue = new bull_1.default('reorder-monitor', env_1.env.REDIS_URL, {
        defaultJobOptions: { removeOnComplete: 100, removeOnFail: 50 },
    });
    reorderQueue.process(async () => {
        logger_1.logger.info('[ReorderJob] Starting reorder check...');
        const settings = await db_1.prisma.reorderSetting.findMany({
            where: { autoReorderEnabled: true, status: 'ACTIVE' },
            include: {
                retailer: true,
                product: { include: { inventory: true } },
            },
        });
        let triggersCreated = 0;
        for (const setting of settings) {
            const totalStock = setting.product.inventory.reduce((sum, inv) => sum + inv.quantityOnHand - inv.quantityReserved, 0);
            if (totalStock <= setting.minThreshold) {
                const recentTrigger = await db_1.prisma.reorderTrigger.findFirst({
                    where: {
                        retailerId: setting.retailerId,
                        productId: setting.productId,
                        status: { in: ['PENDING', 'NOTIFIED'] },
                        triggeredAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
                    },
                });
                if (!recentTrigger) {
                    await db_1.prisma.reorderTrigger.create({
                        data: {
                            retailerId: setting.retailerId,
                            productId: setting.productId,
                            status: 'PENDING',
                        },
                    });
                    await db_1.prisma.notification.create({
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
                    await db_1.prisma.reorderTrigger.updateMany({
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
        logger_1.logger.info(`[ReorderJob] Completed. ${triggersCreated} new triggers created.`);
    });
}
catch (error) {
    logger_1.logger.warn('[ReorderJob] Failed to initialize (Redis may be unavailable):', error);
}
function scheduleReorderJob() {
    if (!reorderQueue)
        return;
    reorderQueue.add({}, { repeat: { every: 10 * 60 * 1000 } });
    logger_1.logger.info('[ReorderJob] Scheduled every 10 minutes');
}
//# sourceMappingURL=reorderJob.js.map
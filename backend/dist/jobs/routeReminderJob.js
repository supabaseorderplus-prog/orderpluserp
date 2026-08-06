"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.routeReminderQueue = void 0;
exports.scheduleRouteReminderJob = scheduleRouteReminderJob;
const bull_1 = __importDefault(require("bull"));
const db_1 = require("../config/db");
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
let routeReminderQueue = null;
exports.routeReminderQueue = routeReminderQueue;
try {
    exports.routeReminderQueue = routeReminderQueue = new bull_1.default('route-reminder', env_1.env.REDIS_URL, {
        defaultJobOptions: { removeOnComplete: 50, removeOnFail: 20 },
    });
    routeReminderQueue.process(async () => {
        logger_1.logger.info('[RouteReminderJob] Sending route briefings...');
        const today = new Date();
        const dayOfWeek = today.getDay();
        const routes = await db_1.prisma.route.findMany({
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
            await db_1.prisma.notification.create({
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
        logger_1.logger.info(`[RouteReminderJob] Sent ${sent} route briefings.`);
    });
}
catch (error) {
    logger_1.logger.warn('[RouteReminderJob] Failed to initialize (Redis may be unavailable):', error);
}
function scheduleRouteReminderJob() {
    if (!routeReminderQueue)
        return;
    routeReminderQueue.add({}, { repeat: { cron: '0 7 * * *' } });
    logger_1.logger.info('[RouteReminderJob] Scheduled daily at 7 AM');
}
//# sourceMappingURL=routeReminderJob.js.map
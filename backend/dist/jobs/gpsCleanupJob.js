"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.gpsCleanupQueue = void 0;
exports.scheduleGpsCleanupJob = scheduleGpsCleanupJob;
const bull_1 = __importDefault(require("bull"));
const db_1 = require("../config/db");
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
let gpsCleanupQueue = null;
exports.gpsCleanupQueue = gpsCleanupQueue;
try {
    exports.gpsCleanupQueue = gpsCleanupQueue = new bull_1.default('gps-cleanup', env_1.env.REDIS_URL, {
        defaultJobOptions: { removeOnComplete: 10, removeOnFail: 5 },
    });
    gpsCleanupQueue.process(async () => {
        logger_1.logger.info('[GpsCleanupJob] Archiving old GPS logs...');
        const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
        const result = await db_1.prisma.gpsLog.deleteMany({
            where: { timestamp: { lt: ninetyDaysAgo } },
        });
        logger_1.logger.info(`[GpsCleanupJob] Archived ${result.count} GPS logs older than 90 days.`);
    });
}
catch (error) {
    logger_1.logger.warn('[GpsCleanupJob] Failed to initialize (Redis may be unavailable):', error);
}
function scheduleGpsCleanupJob() {
    if (!gpsCleanupQueue)
        return;
    gpsCleanupQueue.add({}, { repeat: { cron: '0 3 * * 0' } });
    logger_1.logger.info('[GpsCleanupJob] Scheduled weekly on Sundays at 3 AM');
}
//# sourceMappingURL=gpsCleanupJob.js.map
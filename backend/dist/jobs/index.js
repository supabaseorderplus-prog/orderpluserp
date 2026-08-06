"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.initializeJobs = initializeJobs;
const reorderJob_1 = require("./reorderJob");
const schemeProgressJob_1 = require("./schemeProgressJob");
const routeReminderJob_1 = require("./routeReminderJob");
const gpsCleanupJob_1 = require("./gpsCleanupJob");
const logger_1 = require("../utils/logger");
function initializeJobs() {
    try {
        (0, reorderJob_1.scheduleReorderJob)();
        (0, schemeProgressJob_1.scheduleSchemeProgressJob)();
        (0, routeReminderJob_1.scheduleRouteReminderJob)();
        (0, gpsCleanupJob_1.scheduleGpsCleanupJob)();
        logger_1.logger.info('All background jobs initialized');
    }
    catch (error) {
        logger_1.logger.error('Failed to initialize background jobs:', error);
    }
}
//# sourceMappingURL=index.js.map
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = __importDefault(require("http"));
const app_1 = __importDefault(require("./app"));
const env_1 = require("./config/env");
const socket_1 = require("./config/socket");
const jobs_1 = require("./jobs");
const logger_1 = require("./utils/logger");
const db_1 = require("./config/db");
const server = http_1.default.createServer(app_1.default);
(0, socket_1.initSocket)(server);
const PORT = parseInt(env_1.env.PORT, 10);
server.listen(PORT, () => {
    logger_1.logger.info(`Server running on port ${PORT} in ${env_1.env.NODE_ENV} mode`);
    logger_1.logger.info(`Health check: http://localhost:${PORT}/health`);
    (0, jobs_1.initializeJobs)();
});
function gracefulShutdown(signal) {
    logger_1.logger.info(`${signal} received. Starting graceful shutdown...`);
    server.close(async () => {
        logger_1.logger.info('HTTP server closed');
        try {
            await db_1.prisma.$disconnect();
            logger_1.logger.info('Prisma disconnected');
        }
        catch (err) {
            logger_1.logger.error('Error disconnecting Prisma:', err);
        }
        process.exit(0);
    });
    setTimeout(() => {
        logger_1.logger.error('Graceful shutdown timed out, forcing exit');
        process.exit(1);
    }, 10000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
    logger_1.logger.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (error) => {
    logger_1.logger.error('Uncaught Exception:', error);
    process.exit(1);
});
//# sourceMappingURL=server.js.map
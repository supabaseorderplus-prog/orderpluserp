import http from 'http';
import app from './app';
import { env } from './config/env';
import { initSocket } from './config/socket';
import { initializeJobs } from './jobs';
import { logger } from './utils/logger';
import { prisma } from './config/db';

const server = http.createServer(app);

initSocket(server);

const PORT = parseInt(env.PORT, 10);

server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT} in ${env.NODE_ENV} mode`);
  logger.info(`Health check: http://localhost:${PORT}/health`);
  initializeJobs();
});

function gracefulShutdown(signal: string) {
  logger.info(`${signal} received. Starting graceful shutdown...`);

  server.close(async () => {
    logger.info('HTTP server closed');

    try {
      await prisma.$disconnect();
      logger.info('Prisma disconnected');
    } catch (err) {
      logger.error('Error disconnecting Prisma:', err);
    }

    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  process.exit(1);
});

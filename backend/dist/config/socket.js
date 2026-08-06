"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initSocket = initSocket;
exports.getIO = getIO;
const socket_io_1 = require("socket.io");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const env_1 = require("./env");
const logger_1 = require("../utils/logger");
let io;
function initSocket(httpServer) {
    io = new socket_io_1.Server(httpServer, {
        cors: {
            origin: env_1.env.CORS_ORIGIN.split(','),
            methods: ['GET', 'POST'],
            credentials: true,
        },
        pingTimeout: 60000,
        pingInterval: 25000,
    });
    io.use((socket, next) => {
        const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.replace('Bearer ', '');
        if (!token) {
            return next(new Error('Authentication required'));
        }
        try {
            const decoded = jsonwebtoken_1.default.verify(token, env_1.env.JWT_ACCESS_SECRET);
            socket.userId = decoded.userId;
            socket.role = decoded.role;
            next();
        }
        catch {
            return next(new Error('Invalid token'));
        }
    });
    io.on('connection', (socket) => {
        const userId = socket.userId;
        logger_1.logger.info(`Socket connected: ${socket.id} (user: ${userId})`);
        socket.on('join:tracking', (zoneId) => {
            socket.join(`tracking:${zoneId}`);
        });
        socket.on('join:orders', (targetUserId) => {
            if (targetUserId === userId) {
                socket.join(`orders:${targetUserId}`);
            }
        });
        socket.on('join:notifications', (targetUserId) => {
            if (targetUserId === userId) {
                socket.join(`notifications:${targetUserId}`);
            }
        });
        socket.on('disconnect', () => {
            logger_1.logger.info(`Socket disconnected: ${socket.id}`);
        });
    });
    return io;
}
function getIO() {
    if (!io) {
        throw new Error('Socket.io not initialized');
    }
    return io;
}
//# sourceMappingURL=socket.js.map
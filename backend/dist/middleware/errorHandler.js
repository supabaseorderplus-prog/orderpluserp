"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppError = void 0;
exports.errorHandler = errorHandler;
const zod_1 = require("zod");
const logger_1 = require("../utils/logger");
class AppError extends Error {
    statusCode;
    isOperational;
    constructor(message, statusCode = 500) {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = true;
        Error.captureStackTrace(this, this.constructor);
    }
}
exports.AppError = AppError;
function errorHandler(err, _req, res, _next) {
    if (err instanceof AppError) {
        res.status(err.statusCode).json({
            success: false,
            data: null,
            message: err.message,
        });
        return;
    }
    if (err instanceof zod_1.ZodError) {
        const formatted = err.errors.map((e) => ({
            field: e.path.join('.'),
            message: e.message,
        }));
        res.status(400).json({
            success: false,
            data: formatted,
            message: 'Validation error',
        });
        return;
    }
    logger_1.logger.error('Unhandled error:', err);
    res.status(500).json({
        success: false,
        data: null,
        message: 'Internal server error',
    });
}
//# sourceMappingURL=errorHandler.js.map
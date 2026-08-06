"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const db_1 = require("../../config/db");
const auth_1 = require("../../middleware/auth");
const rbac_1 = require("../../middleware/rbac");
const errorHandler_1 = require("../../middleware/errorHandler");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
const routeSchema = zod_1.z.object({
    name: zod_1.z.string().min(1),
    zoneId: zod_1.z.string().uuid(),
    salesmanId: zod_1.z.string().uuid(),
    scheduleType: zod_1.z.enum(['DAILY', 'WEEKLY']),
    scheduleDays: zod_1.z.array(zod_1.z.number().int().min(0).max(6)).default([]),
});
const stopSchema = zod_1.z.object({
    retailerId: zod_1.z.string().uuid(),
    stopOrder: zod_1.z.number().int().positive(),
    expectedVisitDurationMin: zod_1.z.number().int().positive().default(15),
    notes: zod_1.z.string().optional(),
});
router.get('/', (0, rbac_1.checkPermission)('routes', 'view'), async (req, res, next) => {
    try {
        const q = req.query;
        const page = parseInt(q.page || '1', 10);
        const limit = parseInt(q.limit || '20', 10);
        const where = { status: 'ACTIVE' };
        if (q.zoneId)
            where.zoneId = q.zoneId;
        if (q.salesmanId)
            where.salesmanId = q.salesmanId;
        const [routes, total] = await Promise.all([
            db_1.prisma.route.findMany({ where: where, include: { zone: true, salesman: { select: { id: true, name: true } }, _count: { select: { stops: true } } }, skip: (page - 1) * limit, take: limit }),
            db_1.prisma.route.count({ where: where }),
        ]);
        res.json({ success: true, data: routes, message: 'Routes retrieved', meta: { page, limit, total, totalPages: Math.ceil(total / limit) } });
    }
    catch (error) {
        next(error);
    }
});
router.post('/', (0, rbac_1.checkPermission)('routes', 'create'), async (req, res, next) => {
    try {
        const data = routeSchema.parse(req.body);
        const route = await db_1.prisma.route.create({ data: { ...data, createdBy: req.user.userId }, include: { zone: true, salesman: { select: { id: true, name: true } } } });
        res.status(201).json({ success: true, data: route, message: 'Route created' });
    }
    catch (error) {
        next(error);
    }
});
router.put('/:id', (0, rbac_1.checkPermission)('routes', 'edit'), async (req, res, next) => {
    try {
        const id = req.params.id;
        const data = routeSchema.partial().parse(req.body);
        const route = await db_1.prisma.route.update({ where: { id }, data: data });
        res.json({ success: true, data: route, message: 'Route updated' });
    }
    catch (error) {
        next(error);
    }
});
router.delete('/:id', (0, rbac_1.checkPermission)('routes', 'delete'), async (req, res, next) => {
    try {
        const id = req.params.id;
        await db_1.prisma.route.update({ where: { id }, data: { status: 'DELETED' } });
        res.json({ success: true, data: null, message: 'Route deleted' });
    }
    catch (error) {
        next(error);
    }
});
router.post('/:id/stops', (0, rbac_1.checkPermission)('routes', 'edit'), async (req, res, next) => {
    try {
        const id = req.params.id;
        const data = stopSchema.parse(req.body);
        const stop = await db_1.prisma.routeStop.create({ data: { routeId: id, ...data } });
        res.status(201).json({ success: true, data: stop, message: 'Stop added' });
    }
    catch (error) {
        next(error);
    }
});
router.put('/:id/stops/reorder', (0, rbac_1.checkPermission)('routes', 'edit'), async (req, res, next) => {
    try {
        const { stops } = zod_1.z.object({ stops: zod_1.z.array(zod_1.z.object({ id: zod_1.z.string().uuid(), stopOrder: zod_1.z.number().int() })) }).parse(req.body);
        await Promise.all(stops.map((s) => db_1.prisma.routeStop.update({ where: { id: s.id }, data: { stopOrder: s.stopOrder } })));
        res.json({ success: true, data: null, message: 'Stops reordered' });
    }
    catch (error) {
        next(error);
    }
});
router.post('/:id/execute', (0, rbac_1.checkPermission)('routes', 'edit'), async (req, res, next) => {
    try {
        const id = req.params.id;
        const execution = await db_1.prisma.routeExecution.create({
            data: { routeId: id, salesmanId: req.user.userId, executionDate: new Date(), status: 'IN_PROGRESS', startTime: new Date() },
        });
        res.status(201).json({ success: true, data: execution, message: 'Route execution started' });
    }
    catch (error) {
        next(error);
    }
});
router.put('/executions/:id/stop/:stopId/checkin', (0, rbac_1.checkPermission)('routes', 'edit'), async (req, res, next) => {
    try {
        const id = req.params.id;
        const stopId = req.params.stopId;
        const { latitude, longitude } = zod_1.z.object({ latitude: zod_1.z.number(), longitude: zod_1.z.number() }).parse(req.body);
        const stop = await db_1.prisma.routeStop.findUnique({ where: { id: stopId } });
        if (!stop)
            throw new errorHandler_1.AppError('Stop not found', 404);
        const log = await db_1.prisma.routeStopLog.create({
            data: { routeExecutionId: id, stopId, checkInTime: new Date(), checkInLat: latitude, checkInLng: longitude, isWithinGeofence: true },
        });
        res.json({ success: true, data: log, message: 'Checked in' });
    }
    catch (error) {
        next(error);
    }
});
router.put('/executions/:id/stop/:stopId/checkout', (0, rbac_1.checkPermission)('routes', 'edit'), async (req, res, next) => {
    try {
        const id = req.params.id;
        const stopId = req.params.stopId;
        const { latitude, longitude, notes } = zod_1.z.object({ latitude: zod_1.z.number(), longitude: zod_1.z.number(), notes: zod_1.z.string().optional() }).parse(req.body);
        const existingLog = await db_1.prisma.routeStopLog.findFirst({ where: { routeExecutionId: id, stopId, checkOutTime: null } });
        if (!existingLog)
            throw new errorHandler_1.AppError('No check-in found for this stop', 400);
        const log = await db_1.prisma.routeStopLog.update({ where: { id: existingLog.id }, data: { checkOutTime: new Date(), checkOutLat: latitude, checkOutLng: longitude, notes } });
        const execution = await db_1.prisma.routeExecution.findUnique({ where: { id }, include: { route: { include: { stops: true } } } });
        if (execution) {
            const totalStops = execution.route.stops.length;
            const completedStops = await db_1.prisma.routeStopLog.count({ where: { routeExecutionId: id, checkOutTime: { not: null } } });
            await db_1.prisma.routeExecution.update({ where: { id }, data: { completionPercent: (completedStops / totalStops) * 100 } });
        }
        res.json({ success: true, data: log, message: 'Checked out' });
    }
    catch (error) {
        next(error);
    }
});
router.get('/executions/:id/progress', (0, rbac_1.checkPermission)('routes', 'view'), async (req, res, next) => {
    try {
        const id = req.params.id;
        const execution = await db_1.prisma.routeExecution.findUnique({
            where: { id },
            include: { route: { include: { stops: true } }, stopLogs: { include: { stop: true } } },
        });
        if (!execution)
            throw new errorHandler_1.AppError('Execution not found', 404);
        res.json({ success: true, data: execution, message: 'Progress retrieved' });
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
//# sourceMappingURL=routes.js.map
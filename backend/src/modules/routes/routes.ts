import { Router } from 'express';
import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/db';
import { authenticate } from '../../middleware/auth';
import { checkPermission } from '../../middleware/rbac';
import { AuthRequest, PaginationQuery } from '../../types';
import { AppError } from '../../middleware/errorHandler';

const router = Router();
router.use(authenticate);

const routeSchema = z.object({
  name: z.string().min(1),
  zoneId: z.string().uuid(),
  salesmanId: z.string().uuid(),
  scheduleType: z.enum(['DAILY', 'WEEKLY']),
  scheduleDays: z.array(z.number().int().min(0).max(6)).default([]),
});

const stopSchema = z.object({
  retailerId: z.string().uuid(),
  stopOrder: z.number().int().positive(),
  expectedVisitDurationMin: z.number().int().positive().default(15),
  notes: z.string().optional(),
});

router.get('/', checkPermission('routes', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const q = req.query as PaginationQuery & { zoneId?: string; salesmanId?: string };
    const page = parseInt(q.page || '1', 10);
    const limit = parseInt(q.limit || '20', 10);
    const where: Record<string, unknown> = { status: 'ACTIVE' };
    if (q.zoneId) where.zoneId = q.zoneId;
    if (q.salesmanId) where.salesmanId = q.salesmanId;

    const [routes, total] = await Promise.all([
      prisma.route.findMany({ where: where as never, include: { zone: true, salesman: { select: { id: true, name: true } }, _count: { select: { stops: true } } }, skip: (page - 1) * limit, take: limit }),
      prisma.route.count({ where: where as never }),
    ]);

    res.json({ success: true, data: routes, message: 'Routes retrieved', meta: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) { next(error); }
});

router.post('/', checkPermission('routes', 'create'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = routeSchema.parse(req.body);
    const route = await prisma.route.create({ data: { ...data, createdBy: req.user!.userId }, include: { zone: true, salesman: { select: { id: true, name: true } } } });
    res.status(201).json({ success: true, data: route, message: 'Route created' });
  } catch (error) { next(error); }
});

router.put('/:id', checkPermission('routes', 'edit'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const data = routeSchema.partial().parse(req.body);
    const route = await prisma.route.update({ where: { id }, data: data as never });
    res.json({ success: true, data: route, message: 'Route updated' });
  } catch (error) { next(error); }
});

router.delete('/:id', checkPermission('routes', 'delete'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    await prisma.route.update({ where: { id }, data: { status: 'DELETED' } });
    res.json({ success: true, data: null, message: 'Route deleted' });
  } catch (error) { next(error); }
});

router.post('/:id/stops', checkPermission('routes', 'edit'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const data = stopSchema.parse(req.body);
    const stop = await prisma.routeStop.create({ data: { routeId: id, ...data } });
    res.status(201).json({ success: true, data: stop, message: 'Stop added' });
  } catch (error) { next(error); }
});

router.put('/:id/stops/reorder', checkPermission('routes', 'edit'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { stops } = z.object({ stops: z.array(z.object({ id: z.string().uuid(), stopOrder: z.number().int() })) }).parse(req.body);
    await Promise.all(stops.map((s) => prisma.routeStop.update({ where: { id: s.id }, data: { stopOrder: s.stopOrder } })));
    res.json({ success: true, data: null, message: 'Stops reordered' });
  } catch (error) { next(error); }
});

router.post('/:id/execute', checkPermission('routes', 'edit'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const execution = await prisma.routeExecution.create({
      data: { routeId: id, salesmanId: req.user!.userId, executionDate: new Date(), status: 'IN_PROGRESS', startTime: new Date() },
    });
    res.status(201).json({ success: true, data: execution, message: 'Route execution started' });
  } catch (error) { next(error); }
});

router.put('/executions/:id/stop/:stopId/checkin', checkPermission('routes', 'edit'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const stopId = req.params.stopId as string;
    const { latitude, longitude } = z.object({ latitude: z.number(), longitude: z.number() }).parse(req.body);
    const stop = await prisma.routeStop.findUnique({ where: { id: stopId } });
    if (!stop) throw new AppError('Stop not found', 404);

    const log = await prisma.routeStopLog.create({
      data: { routeExecutionId: id, stopId, checkInTime: new Date(), checkInLat: latitude, checkInLng: longitude, isWithinGeofence: true },
    });
    res.json({ success: true, data: log, message: 'Checked in' });
  } catch (error) { next(error); }
});

router.put('/executions/:id/stop/:stopId/checkout', checkPermission('routes', 'edit'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const stopId = req.params.stopId as string;
    const { latitude, longitude, notes } = z.object({ latitude: z.number(), longitude: z.number(), notes: z.string().optional() }).parse(req.body);
    const existingLog = await prisma.routeStopLog.findFirst({ where: { routeExecutionId: id, stopId, checkOutTime: null } });
    if (!existingLog) throw new AppError('No check-in found for this stop', 400);

    const log = await prisma.routeStopLog.update({ where: { id: existingLog.id }, data: { checkOutTime: new Date(), checkOutLat: latitude, checkOutLng: longitude, notes } });

    const execution = await prisma.routeExecution.findUnique({ where: { id }, include: { route: { include: { stops: true } } } });
    if (execution) {
      const totalStops = execution.route.stops.length;
      const completedStops = await prisma.routeStopLog.count({ where: { routeExecutionId: id, checkOutTime: { not: null } } });
      await prisma.routeExecution.update({ where: { id }, data: { completionPercent: (completedStops / totalStops) * 100 } });
    }

    res.json({ success: true, data: log, message: 'Checked out' });
  } catch (error) { next(error); }
});

router.get('/executions/:id/progress', checkPermission('routes', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const execution = await prisma.routeExecution.findUnique({
      where: { id },
      include: { route: { include: { stops: true } }, stopLogs: { include: { stop: true } } },
    });
    if (!execution) throw new AppError('Execution not found', 404);
    res.json({ success: true, data: execution, message: 'Progress retrieved' });
  } catch (error) { next(error); }
});

export default router;

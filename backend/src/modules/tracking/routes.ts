import { Router } from 'express';
import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { RoleName } from '@prisma/client';
import { prisma } from '../../config/db';
import { authenticate } from '../../middleware/auth';
import { checkPermission } from '../../middleware/rbac';
import { AuthRequest } from '../../types';
import { getIO } from '../../config/socket';

const router = Router();
router.use(authenticate);

const gpsPingSchema = z.object({
  pings: z.array(z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracy: z.number().optional(),
    timestamp: z.string().transform((s) => new Date(s)),
    batteryLevel: z.number().int().min(0).max(100).optional(),
    isMoving: z.boolean().default(false),
    speedKmph: z.number().min(0).optional(),
  })),
});

router.post('/ping', checkPermission('tracking', 'create'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { pings } = gpsPingSchema.parse(req.body);
    const userId = req.user!.userId;

    const data = pings.map((p) => ({
      userId,
      latitude: p.latitude,
      longitude: p.longitude,
      accuracy: p.accuracy,
      timestamp: p.timestamp,
      batteryLevel: p.batteryLevel,
      isMoving: p.isMoving,
      speedKmph: p.speedKmph,
    }));

    await prisma.gpsLog.createMany({ data });

    const latest = pings[pings.length - 1];
    try {
      const io = getIO();
      io.to(`tracking:${req.user!.zoneId}`).emit('gps:update', {
        userId,
        latitude: latest.latitude,
        longitude: latest.longitude,
        timestamp: latest.timestamp,
        isMoving: latest.isMoving,
      });
    } catch {
      // Socket not initialized, skip
    }

    res.json({ success: true, data: { received: pings.length }, message: 'GPS pings recorded' });
  } catch (error) { next(error); }
});

router.get('/live', checkPermission('tracking', 'view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
    const latestLogs = await prisma.$queryRaw`
      SELECT DISTINCT ON (user_id)
        gl.id, gl.user_id, gl.latitude, gl.longitude, gl.accuracy, gl.timestamp,
        gl.battery_level, gl.is_moving, gl.speed_kmph,
        u.name as user_name, u.avatar_url, r.name as role_name
      FROM gps_logs gl
      JOIN users u ON gl.user_id = u.id
      JOIN roles r ON u.role_id = r.id
      WHERE gl.timestamp >= ${thirtyMinAgo}
      ORDER BY user_id, timestamp DESC
    `;
    res.json({ success: true, data: latestLogs, message: 'Live positions retrieved' });
  } catch (error) { next(error); }
});

function buildGpsLog(log: { id: string; userId: string; latitude: unknown; longitude: unknown; accuracy: unknown; batteryLevel: unknown; speedKmph: unknown; timestamp: Date }) {
  return {
    id: log.id,
    salesman_id: log.userId,
    latitude: Number(log.latitude),
    longitude: Number(log.longitude),
    accuracy: log.accuracy != null ? Number(log.accuracy) : undefined,
    battery_level: log.batteryLevel != null ? Number(log.batteryLevel) : undefined,
    speed: log.speedKmph != null ? Number(log.speedKmph) : undefined,
    recorded_at: log.timestamp.toISOString(),
  };
}

function buildSessionFromLogs(
  userId: string,
  date: string,
  logs: { latitude: unknown; longitude: unknown; isMoving: boolean; timestamp: Date }[]
) {
  if (!logs.length) return null;
  const first = logs[0];
  const last = logs[logs.length - 1];
  let totalDistanceKm = 0;
  for (let i = 1; i < logs.length; i++) {
    totalDistanceKm += haversine(
      Number(logs[i - 1].latitude), Number(logs[i - 1].longitude),
      Number(logs[i].latitude), Number(logs[i].longitude)
    );
  }
  const isStillActive = Date.now() - last.timestamp.getTime() < 30 * 60 * 1000;
  return {
    id: `${userId}-${date}`,
    salesman_id: userId,
    date,
    check_in_time: first.timestamp.toISOString(),
    check_out_time: isStillActive ? null : last.timestamp.toISOString(),
    check_in_lat: Number(first.latitude),
    check_in_lng: Number(first.longitude),
    total_distance_km: Math.round(totalDistanceKm * 100) / 100,
    total_stops: logs.filter((l) => !l.isMoving).length,
    status: isStillActive ? 'active' : 'checked_out',
    notes: null,
  };
}

async function fetchUsersWithGps(roleName: RoleName, date: string) {
  const startOfDay = new Date(`${date}T00:00:00.000Z`);
  const endOfDay = new Date(`${date}T23:59:59.999Z`);

  const users = await prisma.user.findMany({
    where: { role: { name: roleName }, status: 'ACTIVE' },
    include: { role: true },
    orderBy: { name: 'asc' },
  });

  const userIds = users.map((u) => u.id);
  const allLogs = userIds.length
    ? await prisma.gpsLog.findMany({
        where: { userId: { in: userIds }, timestamp: { gte: startOfDay, lte: endOfDay } },
        orderBy: { timestamp: 'asc' },
      })
    : [];

  const logsByUser: Record<string, typeof allLogs> = {};
  for (const log of allLogs) {
    if (!logsByUser[log.userId]) logsByUser[log.userId] = [];
    logsByUser[log.userId].push(log);
  }

  return users.map((user) => {
    const logs = logsByUser[user.id] ?? [];
    const lastLog = logs[logs.length - 1] ?? null;
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      employee_code: null,
      phone: user.phone ?? null,
      territory_id: null,
      territories: null,
      role: user.role.name,
      active_lot: null,
      session: buildSessionFromLogs(user.id, date, logs),
      latest_location: lastLog ? buildGpsLog(lastLog) : null,
    };
  });
}

router.get('/salesmen', checkPermission('tracking', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const date = (req.query.date as string) || new Date().toISOString().split('T')[0];
    const data = await fetchUsersWithGps('SALESMAN', date);
    res.json({ success: true, data, message: 'Salesmen retrieved' });
  } catch (error) { next(error); }
});

router.get('/drivers', checkPermission('tracking', 'view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    res.json({ success: true, data: [], message: 'Drivers retrieved' });
  } catch (error) { next(error); }
});

router.get('/location', checkPermission('tracking', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const salesmanId = req.query.salesman_id as string;
    const date = (req.query.date as string) || new Date().toISOString().split('T')[0];
    const limit = Math.min(parseInt(req.query.limit as string) || 1000, 5000);

    if (!salesmanId) {
      res.status(400).json({ success: false, message: 'salesman_id is required' });
      return;
    }

    const startOfDay = new Date(`${date}T00:00:00.000Z`);
    const endOfDay = new Date(`${date}T23:59:59.999Z`);

    const logs = await prisma.gpsLog.findMany({
      where: { userId: salesmanId, timestamp: { gte: startOfDay, lte: endOfDay } },
      orderBy: { timestamp: 'asc' },
      take: limit,
    });

    res.json({ success: true, data: logs.map(buildGpsLog), message: 'Location history retrieved' });
  } catch (error) { next(error); }
});

router.get('/:userId/history', checkPermission('tracking', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.params.userId as string;
    const date = req.query.date as string || new Date().toISOString().split('T')[0];
    const startOfDay = new Date(`${date}T00:00:00.000Z`);
    const endOfDay = new Date(`${date}T23:59:59.999Z`);

    const logs = await prisma.gpsLog.findMany({
      where: { userId, timestamp: { gte: startOfDay, lte: endOfDay } },
      orderBy: { timestamp: 'asc' },
    });

    res.json({ success: true, data: logs, message: 'GPS history retrieved' });
  } catch (error) { next(error); }
});

router.get('/:userId/distance', checkPermission('tracking', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.params.userId as string;
    const date = req.query.date as string || new Date().toISOString().split('T')[0];
    const startOfDay = new Date(`${date}T00:00:00.000Z`);
    const endOfDay = new Date(`${date}T23:59:59.999Z`);

    const logs = await prisma.gpsLog.findMany({
      where: { userId, timestamp: { gte: startOfDay, lte: endOfDay } },
      orderBy: { timestamp: 'asc' },
    });

    let totalDistance = 0;
    for (let i = 1; i < logs.length; i++) {
      totalDistance += haversine(
        Number(logs[i - 1].latitude), Number(logs[i - 1].longitude),
        Number(logs[i].latitude), Number(logs[i].longitude)
      );
    }

    res.json({ success: true, data: { date, totalDistanceKm: Math.round(totalDistance * 100) / 100, pointCount: logs.length }, message: 'Distance calculated' });
  } catch (error) { next(error); }
});

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default router;

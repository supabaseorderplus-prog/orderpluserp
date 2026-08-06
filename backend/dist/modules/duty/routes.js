"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const db_1 = require("../../config/db");
const auth_1 = require("../../middleware/auth");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
// ── Helpers ──────────────────────────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
async function getSessionForUser(userId, date) {
    const startOfDay = new Date(`${date}T00:00:00.000Z`);
    const endOfDay = new Date(`${date}T23:59:59.999Z`);
    const logs = await db_1.prisma.gpsLog.findMany({
        where: { userId, timestamp: { gte: startOfDay, lte: endOfDay } },
        orderBy: { timestamp: 'asc' },
    });
    if (!logs.length)
        return null;
    const first = logs[0];
    const last = logs[logs.length - 1];
    let totalDistanceKm = 0;
    for (let i = 1; i < logs.length; i++) {
        totalDistanceKm += haversine(Number(logs[i - 1].latitude), Number(logs[i - 1].longitude), Number(logs[i].latitude), Number(logs[i].longitude));
    }
    const isActive = Date.now() - last.timestamp.getTime() < 30 * 60 * 1000;
    return {
        id: `${userId}-${date}`,
        salesman_id: userId,
        date,
        check_in_time: first.timestamp.toISOString(),
        check_out_time: isActive ? null : last.timestamp.toISOString(),
        check_in_lat: Number(first.latitude),
        check_in_lng: Number(first.longitude),
        total_distance_km: Math.round(totalDistanceKm * 100) / 100,
        total_stops: logs.filter((l) => !l.isMoving).length,
        status: isActive ? 'active' : 'checked_out',
        notes: null,
    };
}
// ── GET /api/v1/duty/session — today's virtual session ────────────────────────
router.get('/session', async (req, res, next) => {
    try {
        const userId = req.user.userId;
        const date = req.query.date || new Date().toISOString().split('T')[0];
        const session = await getSessionForUser(userId, date);
        res.json({ success: true, data: session });
    }
    catch (err) {
        next(err);
    }
});
// ── POST /api/v1/duty/session — check-in (optionally records first GPS point) ─
router.post('/session', async (req, res, next) => {
    try {
        const userId = req.user.userId;
        const { latitude, longitude } = req.body;
        const date = new Date().toISOString().split('T')[0];
        // If coordinates provided, store the check-in point as the first GPS log
        if (latitude != null && longitude != null && !isNaN(latitude) && !isNaN(longitude)) {
            await db_1.prisma.gpsLog.create({
                data: {
                    userId,
                    latitude,
                    longitude,
                    accuracy: req.body.accuracy ?? null,
                    timestamp: new Date(),
                    batteryLevel: req.body.battery_level ?? null,
                    isMoving: false,
                    speedKmph: null,
                },
            });
        }
        const session = await getSessionForUser(userId, date);
        res.json({ success: true, data: session });
    }
    catch (err) {
        next(err);
    }
});
// ── PATCH /api/v1/duty/session — check-out ────────────────────────────────────
router.patch('/session', async (req, res, next) => {
    try {
        const userId = req.user.userId;
        const { latitude, longitude } = req.body;
        const date = new Date().toISOString().split('T')[0];
        // Record the final location as a stopped ping
        if (latitude != null && longitude != null && !isNaN(latitude) && !isNaN(longitude)) {
            await db_1.prisma.gpsLog.create({
                data: {
                    userId,
                    latitude,
                    longitude,
                    accuracy: req.body.accuracy ?? null,
                    timestamp: new Date(),
                    batteryLevel: req.body.battery_level ?? null,
                    isMoving: false,
                    speedKmph: null,
                },
            });
        }
        // Force the session to appear as checked-out by fetching with a past-end timestamp
        const session = await getSessionForUser(userId, date);
        if (session)
            session.status = 'checked_out';
        res.json({ success: true, data: session });
    }
    catch (err) {
        next(err);
    }
});
// ── POST /api/v1/duty/location — single GPS ping from native Android service ──
// Accepts both the native Android format and the web JS format.
const locationSchema = zod_1.z.object({
    latitude: zod_1.z.number().min(-90).max(90),
    longitude: zod_1.z.number().min(-180).max(180),
    accuracy: zod_1.z.number().optional().nullable(),
    // native service uses "speed" (m/s) + "activity"; web uses "speed" too
    speed: zod_1.z.number().optional().nullable(),
    heading: zod_1.z.number().optional().nullable(),
    activity: zod_1.z.string().optional().nullable(),
    battery_level: zod_1.z.number().int().min(0).max(100).optional().nullable(),
    total_distance_km: zod_1.z.number().optional().nullable(),
    // timestamps — accept either field name
    recorded_at: zod_1.z.string().optional().nullable(),
    queued_at: zod_1.z.string().optional().nullable(),
});
router.post('/location', async (req, res, next) => {
    try {
        const userId = req.user.userId;
        const body = locationSchema.parse(req.body);
        const ts = body.recorded_at
            ? new Date(body.recorded_at)
            : body.queued_at
                ? new Date(body.queued_at)
                : new Date();
        // Convert m/s → km/h (FusedLocationProvider gives speed in m/s)
        const speedKmph = body.speed != null ? body.speed * 3.6 : null;
        const isMoving = body.activity != null ? body.activity === 'moving' : (speedKmph != null && speedKmph > 1.0);
        await db_1.prisma.gpsLog.create({
            data: {
                userId,
                latitude: body.latitude,
                longitude: body.longitude,
                accuracy: body.accuracy ?? null,
                timestamp: ts,
                batteryLevel: body.battery_level ?? null,
                isMoving,
                speedKmph: speedKmph != null ? Math.round(speedKmph * 100) / 100 : null,
            },
        });
        res.json({ success: true, data: { received: 1 } });
    }
    catch (err) {
        next(err);
    }
});
exports.default = router;
//# sourceMappingURL=routes.js.map
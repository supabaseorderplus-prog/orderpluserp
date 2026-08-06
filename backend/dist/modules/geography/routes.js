"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const db_1 = require("../../config/db");
const auth_1 = require("../../middleware/auth");
const rbac_1 = require("../../middleware/rbac");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
// ── States ──
router.get('/states', (0, rbac_1.checkPermission)('geography', 'view'), async (_req, res, next) => {
    try {
        const states = await db_1.prisma.state.findMany({ where: { status: 'ACTIVE' }, orderBy: { name: 'asc' } });
        res.json({ success: true, data: states, message: 'States retrieved' });
    }
    catch (e) {
        next(e);
    }
});
router.post('/states', (0, rbac_1.checkPermission)('geography', 'create'), async (req, res, next) => {
    try {
        const data = zod_1.z.object({ name: zod_1.z.string(), code: zod_1.z.string().length(2) }).parse(req.body);
        const state = await db_1.prisma.state.create({ data: { ...data, createdBy: req.user.userId } });
        res.status(201).json({ success: true, data: state, message: 'State created' });
    }
    catch (e) {
        next(e);
    }
});
// ── Districts ──
router.get('/districts', (0, rbac_1.checkPermission)('geography', 'view'), async (req, res, next) => {
    try {
        const q = req.query;
        const where = { status: 'ACTIVE' };
        if (q.stateId)
            where.stateId = q.stateId;
        const districts = await db_1.prisma.district.findMany({ where: where, include: { state: true }, orderBy: { name: 'asc' } });
        res.json({ success: true, data: districts, message: 'Districts retrieved' });
    }
    catch (e) {
        next(e);
    }
});
router.post('/districts', (0, rbac_1.checkPermission)('geography', 'create'), async (req, res, next) => {
    try {
        const data = zod_1.z.object({ name: zod_1.z.string(), stateId: zod_1.z.string().uuid() }).parse(req.body);
        const district = await db_1.prisma.district.create({ data: { ...data, createdBy: req.user.userId } });
        res.status(201).json({ success: true, data: district, message: 'District created' });
    }
    catch (e) {
        next(e);
    }
});
// ── Zones ──
router.get('/zones', (0, rbac_1.checkPermission)('geography', 'view'), async (req, res, next) => {
    try {
        const q = req.query;
        const where = { status: 'ACTIVE' };
        if (q.districtId)
            where.districtId = q.districtId;
        if (q.stateId)
            where.stateId = q.stateId;
        const zones = await db_1.prisma.zone.findMany({ where: where, include: { district: { include: { state: true } } }, orderBy: { name: 'asc' } });
        res.json({ success: true, data: zones, message: 'Zones retrieved' });
    }
    catch (e) {
        next(e);
    }
});
router.post('/zones', (0, rbac_1.checkPermission)('geography', 'create'), async (req, res, next) => {
    try {
        const data = zod_1.z.object({ name: zod_1.z.string(), stateId: zod_1.z.string().uuid(), districtId: zod_1.z.string().uuid() }).parse(req.body);
        const zone = await db_1.prisma.zone.create({ data: { ...data, createdBy: req.user.userId } });
        res.status(201).json({ success: true, data: zone, message: 'Zone created' });
    }
    catch (e) {
        next(e);
    }
});
router.put('/zones/:id', (0, rbac_1.checkPermission)('geography', 'edit'), async (req, res, next) => {
    try {
        const id = req.params.id;
        const data = zod_1.z.object({ name: zod_1.z.string().optional(), isActive: zod_1.z.boolean().optional() }).parse(req.body);
        const zone = await db_1.prisma.zone.update({ where: { id }, data });
        res.json({ success: true, data: zone, message: 'Zone updated' });
    }
    catch (e) {
        next(e);
    }
});
router.post('/zones/:id/assign-user', (0, rbac_1.checkPermission)('geography', 'edit'), async (req, res, next) => {
    try {
        const id = req.params.id;
        const { userId } = zod_1.z.object({ userId: zod_1.z.string().uuid() }).parse(req.body);
        const assignment = await db_1.prisma.userZoneAssignment.upsert({
            where: { userId_zoneId: { userId, zoneId: id } },
            create: { userId, zoneId: id, assignedBy: req.user.userId },
            update: { assignedBy: req.user.userId, status: 'ACTIVE' },
        });
        await db_1.prisma.user.update({ where: { id: userId }, data: { zoneId: id } });
        res.json({ success: true, data: assignment, message: 'User assigned to zone' });
    }
    catch (e) {
        next(e);
    }
});
exports.default = router;
//# sourceMappingURL=routes.js.map
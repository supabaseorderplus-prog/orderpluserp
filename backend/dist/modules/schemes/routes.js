"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const db_1 = require("../../config/db");
const auth_1 = require("../../middleware/auth");
const rbac_1 = require("../../middleware/rbac");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
const schemeSchema = zod_1.z.object({
    name: zod_1.z.string().min(1),
    description: zod_1.z.string().optional(),
    schemeType: zod_1.z.enum(['TARGET_REWARD', 'VOLUME_SLAB', 'COMBO', 'TIME_CAMPAIGN']),
    applicableRole: zod_1.z.enum(['SUPER_ADMIN', 'ADMIN', 'SALES_MANAGER', 'FIELD_MANAGER', 'SALESMAN', 'DISTRIBUTOR', 'SUB_DISTRIBUTOR', 'RETAILER', 'WAREHOUSE_MANAGER', 'ACCOUNTANT']),
    zoneId: zod_1.z.string().uuid().nullable().optional(),
    validFrom: zod_1.z.string().transform((s) => new Date(s)),
    validTo: zod_1.z.string().transform((s) => new Date(s)),
    rewardType: zod_1.z.enum(['CASH', 'PRODUCT', 'CREDIT_NOTE', 'GIFT']),
    rewardValue: zod_1.z.number().positive(),
    conditions: zod_1.z.record(zod_1.z.unknown()).optional(),
});
router.get('/', (0, rbac_1.checkPermission)('schemes', 'view'), async (req, res, next) => {
    try {
        const q = req.query;
        const page = parseInt(q.page || '1', 10);
        const limit = parseInt(q.limit || '20', 10);
        const [schemes, total] = await Promise.all([
            db_1.prisma.scheme.findMany({ where: { status: 'ACTIVE' }, include: { zone: true }, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' } }),
            db_1.prisma.scheme.count({ where: { status: 'ACTIVE' } }),
        ]);
        res.json({ success: true, data: schemes, message: 'Schemes retrieved', meta: { page, limit, total, totalPages: Math.ceil(total / limit) } });
    }
    catch (error) {
        next(error);
    }
});
router.post('/', (0, rbac_1.checkPermission)('schemes', 'create'), async (req, res, next) => {
    try {
        const data = schemeSchema.parse(req.body);
        const scheme = await db_1.prisma.scheme.create({ data: { ...data, zoneId: data.zoneId ?? null, conditions: data.conditions, createdBy: req.user.userId } });
        res.status(201).json({ success: true, data: scheme, message: 'Scheme created' });
    }
    catch (error) {
        next(error);
    }
});
router.put('/:id', (0, rbac_1.checkPermission)('schemes', 'edit'), async (req, res, next) => {
    try {
        const id = req.params.id;
        const data = schemeSchema.partial().parse(req.body);
        const scheme = await db_1.prisma.scheme.update({ where: { id }, data: data });
        res.json({ success: true, data: scheme, message: 'Scheme updated' });
    }
    catch (error) {
        next(error);
    }
});
router.delete('/:id', (0, rbac_1.checkPermission)('schemes', 'delete'), async (req, res, next) => {
    try {
        const id = req.params.id;
        await db_1.prisma.scheme.update({ where: { id }, data: { status: 'DELETED' } });
        res.json({ success: true, data: null, message: 'Scheme deleted' });
    }
    catch (error) {
        next(error);
    }
});
router.get('/active', (0, rbac_1.checkPermission)('schemes', 'view'), async (req, res, next) => {
    try {
        const now = new Date();
        const schemes = await db_1.prisma.scheme.findMany({
            where: { isActive: true, status: 'ACTIVE', validFrom: { lte: now }, validTo: { gte: now }, OR: [{ applicableRole: req.user.roleName }, { zoneId: null }] },
        });
        res.json({ success: true, data: schemes, message: 'Active schemes retrieved' });
    }
    catch (error) {
        next(error);
    }
});
router.get('/:id/progress/:userId', (0, rbac_1.checkPermission)('schemes', 'view'), async (req, res, next) => {
    try {
        const schemeId = req.params.id;
        const userId = req.params.userId;
        const progress = await db_1.prisma.schemeProgress.findUnique({ where: { schemeId_userId: { schemeId, userId } } });
        res.json({ success: true, data: progress, message: 'Progress retrieved' });
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
//# sourceMappingURL=routes.js.map
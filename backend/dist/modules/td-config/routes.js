"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const db_1 = require("../../config/db");
const auth_1 = require("../../middleware/auth");
const rbac_1 = require("../../middleware/rbac");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
const tdConfigSchema = zod_1.z.object({
    type: zod_1.z.enum(['td', 'cd']),
    applicablePartyType: zod_1.z.enum(['CNF', 'SUPER_DEALER', 'RETAILER']),
    partyId: zod_1.z.string().uuid().nullable().optional(),
    tdPercent: zod_1.z.number().positive().optional(),
    slabName: zod_1.z.enum(['ON_DELIVERY', 'WITHIN_7_DAYS', 'WITHIN_15_DAYS', 'WITHIN_30_DAYS']).optional(),
    cdPercent: zod_1.z.number().positive().optional(),
    validFrom: zod_1.z.string(),
    validTo: zod_1.z.string().nullable().optional(),
    notes: zod_1.z.string().optional(),
    status: zod_1.z.enum(['ACTIVE', 'INACTIVE', 'DELETED']).optional(),
});
router.get('/', (0, rbac_1.checkPermission)('pricing', 'view'), async (req, res, next) => {
    try {
        const [tdConfigs, cdConfigs] = await Promise.all([
            db_1.prisma.tDConfig.findMany({
                where: { status: { not: 'DELETED' } },
                include: { party: true },
                orderBy: { createdAt: 'desc' },
            }),
            db_1.prisma.cDConfig.findMany({
                where: { status: { not: 'DELETED' } },
                include: { party: true },
                orderBy: { createdAt: 'desc' },
            }),
        ]);
        res.json({ success: true, data: { td: tdConfigs, cd: cdConfigs }, message: 'TD/CD configs retrieved' });
    }
    catch (error) {
        next(error);
    }
});
router.post('/', (0, rbac_1.checkPermission)('pricing', 'create'), async (req, res, next) => {
    try {
        const data = tdConfigSchema.parse(req.body);
        const { type, ...rest } = data;
        if (type === 'td') {
            const tdConfig = await db_1.prisma.tDConfig.create({
                data: {
                    applicablePartyType: rest.applicablePartyType,
                    partyId: rest.partyId || null,
                    tdPercent: rest.tdPercent || 0,
                    validFrom: new Date(rest.validFrom),
                    validTo: rest.validTo ? new Date(rest.validTo) : null,
                    notes: rest.notes || null,
                    status: rest.status || 'ACTIVE',
                    createdBy: req.user.userId,
                },
                include: { party: true },
            });
            res.status(201).json({ success: true, data: tdConfig, message: 'TD config created' });
        }
        else if (type === 'cd') {
            const cdConfig = await db_1.prisma.cDConfig.create({
                data: {
                    applicablePartyType: rest.applicablePartyType,
                    partyId: rest.partyId || null,
                    slabName: rest.slabName || 'ON_DELIVERY',
                    cdPercent: rest.cdPercent || 0,
                    validFrom: new Date(rest.validFrom),
                    validTo: rest.validTo ? new Date(rest.validTo) : null,
                    notes: rest.notes || null,
                    status: rest.status || 'ACTIVE',
                    createdBy: req.user.userId,
                },
                include: { party: true },
            });
            res.status(201).json({ success: true, data: cdConfig, message: 'CD config created' });
        }
    }
    catch (error) {
        next(error);
    }
});
router.put('/', (0, rbac_1.checkPermission)('pricing', 'edit'), async (req, res, next) => {
    try {
        const data = tdConfigSchema.partial().extend({ id: zod_1.z.string().uuid() }).parse(req.body);
        const { type, id, ...rest } = data;
        if (type === 'td') {
            const tdConfig = await db_1.prisma.tDConfig.update({
                where: { id },
                data: {
                    applicablePartyType: rest.applicablePartyType,
                    partyId: rest.partyId !== undefined ? rest.partyId : undefined,
                    tdPercent: rest.tdPercent,
                    validFrom: rest.validFrom ? new Date(rest.validFrom) : undefined,
                    validTo: rest.validTo !== undefined ? (rest.validTo ? new Date(rest.validTo) : null) : undefined,
                    notes: rest.notes,
                    status: rest.status,
                },
                include: { party: true },
            });
            res.json({ success: true, data: tdConfig, message: 'TD config updated' });
        }
        else if (type === 'cd') {
            const cdConfig = await db_1.prisma.cDConfig.update({
                where: { id },
                data: {
                    applicablePartyType: rest.applicablePartyType,
                    partyId: rest.partyId !== undefined ? rest.partyId : undefined,
                    slabName: rest.slabName,
                    cdPercent: rest.cdPercent,
                    validFrom: rest.validFrom ? new Date(rest.validFrom) : undefined,
                    validTo: rest.validTo !== undefined ? (rest.validTo ? new Date(rest.validTo) : null) : undefined,
                    notes: rest.notes,
                    status: rest.status,
                },
                include: { party: true },
            });
            res.json({ success: true, data: cdConfig, message: 'CD config updated' });
        }
    }
    catch (error) {
        next(error);
    }
});
router.delete('/', (0, rbac_1.checkPermission)('pricing', 'delete'), async (req, res, next) => {
    try {
        const { id, type } = req.query;
        if (type === 'td') {
            await db_1.prisma.tDConfig.update({ where: { id }, data: { status: 'DELETED' } });
        }
        else if (type === 'cd') {
            await db_1.prisma.cDConfig.update({ where: { id }, data: { status: 'DELETED' } });
        }
        res.json({ success: true, data: null, message: 'Config deleted' });
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
//# sourceMappingURL=routes.js.map
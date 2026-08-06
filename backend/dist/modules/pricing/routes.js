"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const db_1 = require("../../config/db");
const auth_1 = require("../../middleware/auth");
const rbac_1 = require("../../middleware/rbac");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
const pricingRuleSchema = zod_1.z.object({
    productId: zod_1.z.string().uuid(),
    zoneId: zod_1.z.string().uuid().nullable().optional(),
    customerGroup: zod_1.z.enum(['DISTRIBUTOR', 'SUB_DISTRIBUTOR', 'RETAILER', 'DIRECT']),
    priceType: zod_1.z.enum(['FIXED', 'MARGIN_PERCENT']),
    priceValue: zod_1.z.number().positive(),
    minMarginFloor: zod_1.z.number().optional(),
    maxMarginCeiling: zod_1.z.number().optional(),
    validFrom: zod_1.z.string().transform((s) => new Date(s)),
    validTo: zod_1.z.string().transform((s) => new Date(s)).nullable().optional(),
    changeReason: zod_1.z.string().min(1),
});
const slabSchema = zod_1.z.object({
    productId: zod_1.z.string().uuid(),
    customerGroup: zod_1.z.enum(['DISTRIBUTOR', 'SUB_DISTRIBUTOR', 'RETAILER', 'DIRECT']),
    minQty: zod_1.z.number().int().positive(),
    maxQty: zod_1.z.number().int().positive().nullable().optional(),
    slabPrice: zod_1.z.number().positive(),
    zoneId: zod_1.z.string().uuid().nullable().optional(),
});
const computeSchema = zod_1.z.object({
    productId: zod_1.z.string().uuid(),
    role: zod_1.z.enum(['DISTRIBUTOR', 'SUB_DISTRIBUTOR', 'RETAILER', 'DIRECT']),
    quantity: zod_1.z.number().int().positive(),
    zoneId: zod_1.z.string().uuid().optional(),
});
router.get('/rules', (0, rbac_1.checkPermission)('pricing', 'view'), async (req, res, next) => {
    try {
        const q = req.query;
        const page = parseInt(q.page || '1', 10);
        const limit = parseInt(q.limit || '20', 10);
        const where = { status: 'ACTIVE' };
        if (q.productId)
            where.productId = q.productId;
        const [rules, total] = await Promise.all([
            db_1.prisma.pricingRule.findMany({ where: where, include: { product: true, zone: true }, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' } }),
            db_1.prisma.pricingRule.count({ where: where }),
        ]);
        res.json({ success: true, data: rules, message: 'Pricing rules retrieved', meta: { page, limit, total, totalPages: Math.ceil(total / limit) } });
    }
    catch (error) {
        next(error);
    }
});
router.post('/rules', (0, rbac_1.checkPermission)('pricing', 'create'), async (req, res, next) => {
    try {
        const { changeReason, ...data } = pricingRuleSchema.parse(req.body);
        const rule = await db_1.prisma.pricingRule.create({
            data: { ...data, zoneId: data.zoneId ?? null, validTo: data.validTo ?? null, createdBy: req.user.userId },
        });
        await db_1.prisma.pricingAuditLog.create({
            data: { pricingRuleId: rule.id, changedBy: req.user.userId, oldValue: {}, newValue: data, changeReason },
        });
        res.status(201).json({ success: true, data: rule, message: 'Pricing rule created' });
    }
    catch (error) {
        next(error);
    }
});
router.put('/rules/:id', (0, rbac_1.checkPermission)('pricing', 'edit'), async (req, res, next) => {
    try {
        const id = req.params.id;
        const { changeReason, ...data } = pricingRuleSchema.partial().extend({ changeReason: zod_1.z.string().min(1) }).parse(req.body);
        const old = await db_1.prisma.pricingRule.findUnique({ where: { id } });
        const rule = await db_1.prisma.pricingRule.update({ where: { id }, data: data });
        await db_1.prisma.pricingAuditLog.create({
            data: { pricingRuleId: rule.id, changedBy: req.user.userId, oldValue: old, newValue: data, changeReason },
        });
        res.json({ success: true, data: rule, message: 'Pricing rule updated' });
    }
    catch (error) {
        next(error);
    }
});
router.delete('/rules/:id', (0, rbac_1.checkPermission)('pricing', 'delete'), async (req, res, next) => {
    try {
        const id = req.params.id;
        await db_1.prisma.pricingRule.update({ where: { id }, data: { status: 'DELETED' } });
        res.json({ success: true, data: null, message: 'Pricing rule deleted' });
    }
    catch (error) {
        next(error);
    }
});
router.get('/slabs', (0, rbac_1.checkPermission)('pricing', 'view'), async (req, res, next) => {
    try {
        const q = req.query;
        const where = { status: 'ACTIVE' };
        if (q.productId)
            where.productId = q.productId;
        const slabs = await db_1.prisma.bulkPricingSlab.findMany({ where: where, include: { product: true }, orderBy: { minQty: 'asc' } });
        res.json({ success: true, data: slabs, message: 'Slabs retrieved' });
    }
    catch (error) {
        next(error);
    }
});
router.post('/slabs', (0, rbac_1.checkPermission)('pricing', 'create'), async (req, res, next) => {
    try {
        const data = slabSchema.parse(req.body);
        const slab = await db_1.prisma.bulkPricingSlab.create({ data: { ...data, zoneId: data.zoneId ?? null, maxQty: data.maxQty ?? null, createdBy: req.user.userId } });
        res.status(201).json({ success: true, data: slab, message: 'Slab created' });
    }
    catch (error) {
        next(error);
    }
});
router.get('/audit-log', (0, rbac_1.checkPermission)('pricing', 'view'), async (req, res, next) => {
    try {
        const q = req.query;
        const where = {};
        if (q.productId)
            where.pricingRule = { productId: q.productId };
        if (q.from || q.to) {
            where.changedAt = {};
            if (q.from)
                where.changedAt.gte = new Date(q.from);
            if (q.to)
                where.changedAt.lte = new Date(q.to);
        }
        const logs = await db_1.prisma.pricingAuditLog.findMany({ where: where, include: { pricingRule: { include: { product: true } }, changedByUser: true }, orderBy: { changedAt: 'desc' }, take: 100 });
        res.json({ success: true, data: logs, message: 'Audit log retrieved' });
    }
    catch (error) {
        next(error);
    }
});
router.post('/compute', (0, rbac_1.checkPermission)('pricing', 'view'), async (req, res, next) => {
    try {
        const { productId, role, quantity, zoneId } = computeSchema.parse(req.body);
        const product = await db_1.prisma.product.findUnique({ where: { id: productId } });
        if (!product) {
            res.status(404).json({ success: false, data: null, message: 'Product not found' });
            return;
        }
        const rule = await db_1.prisma.pricingRule.findFirst({
            where: { productId, customerGroup: role, isActive: true, status: 'ACTIVE', validFrom: { lte: new Date() }, OR: [{ validTo: null }, { validTo: { gte: new Date() } }] },
            orderBy: [{ zoneId: 'desc' }, { createdAt: 'desc' }],
        });
        let unitPrice = Number(product.basePrice);
        if (rule) {
            unitPrice = rule.priceType === 'FIXED' ? Number(rule.priceValue) : Number(product.basePrice) * (1 + Number(rule.priceValue) / 100);
        }
        const slab = await db_1.prisma.bulkPricingSlab.findFirst({
            where: { productId, customerGroup: role, status: 'ACTIVE', minQty: { lte: quantity }, OR: [{ maxQty: null }, { maxQty: { gte: quantity } }] },
        });
        if (slab)
            unitPrice = Number(slab.slabPrice);
        const lineTotal = unitPrice * quantity;
        res.json({ success: true, data: { unitPrice, quantity, lineTotal, appliedRule: rule?.id, appliedSlab: slab?.id }, message: 'Price computed' });
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
//# sourceMappingURL=routes.js.map
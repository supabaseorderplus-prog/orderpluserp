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
const productSchema = zod_1.z.object({
    sku: zod_1.z.string().min(1).max(50),
    name: zod_1.z.string().min(1).max(200),
    brandId: zod_1.z.string().uuid(),
    categoryId: zod_1.z.string().uuid(),
    unitType: zod_1.z.enum(['KG', 'LITRE', 'BAG', 'PIECE', 'SET']),
    basePrice: zod_1.z.number().positive(),
    description: zod_1.z.string().optional(),
    technicalSpecs: zod_1.z.record(zod_1.z.unknown()).optional(),
    isZoneRestricted: zod_1.z.boolean().optional(),
    weightKg: zod_1.z.number().positive().optional(),
    hsnCode: zod_1.z.string().min(4).max(8),
    gstRate: zod_1.z.enum(['GST_5', 'GST_12', 'GST_18', 'GST_28']),
    sortOrder: zod_1.z.number().int().optional(),
});
router.get('/', (0, rbac_1.checkPermission)('products', 'view'), async (req, res, next) => {
    try {
        const q = req.query;
        const page = parseInt(q.page || '1', 10);
        const limit = parseInt(q.limit || '20', 10);
        const where = { status: { not: 'DELETED' } };
        if (q.categoryId)
            where.categoryId = q.categoryId;
        if (q.brandId)
            where.brandId = q.brandId;
        if (q.search)
            where.OR = [
                { name: { contains: q.search, mode: 'insensitive' } },
                { sku: { contains: q.search, mode: 'insensitive' } },
            ];
        const [products, total] = await Promise.all([
            db_1.prisma.product.findMany({
                where: where,
                include: { brand: true, category: true },
                skip: (page - 1) * limit,
                take: limit,
                orderBy: { [q.sort || 'createdAt']: q.order || 'desc' },
            }),
            db_1.prisma.product.count({ where: where }),
        ]);
        res.json({
            success: true, data: products, message: 'Products retrieved',
            meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
        });
    }
    catch (error) {
        next(error);
    }
});
router.post('/', (0, rbac_1.checkPermission)('products', 'create'), async (req, res, next) => {
    try {
        const data = productSchema.parse(req.body);
        const product = await db_1.prisma.product.create({
            data: { ...data, basePrice: data.basePrice, weightKg: data.weightKg, technicalSpecs: data.technicalSpecs, createdBy: req.user.userId },
            include: { brand: true, category: true },
        });
        await db_1.prisma.auditLog.create({
            data: { userId: req.user.userId, action: 'CREATE', module: 'products', recordId: product.id, newData: { sku: product.sku, name: product.name }, ipAddress: req.ip || null, userAgent: req.headers['user-agent'] || null },
        });
        res.status(201).json({ success: true, data: product, message: 'Product created' });
    }
    catch (error) {
        next(error);
    }
});
router.get('/:id', (0, rbac_1.checkPermission)('products', 'view'), async (req, res, next) => {
    try {
        const id = req.params.id;
        const product = await db_1.prisma.product.findUnique({
            where: { id },
            include: { brand: true, category: true, pricingRules: { where: { isActive: true } }, inventory: { include: { warehouse: true } } },
        });
        if (!product || product.status === 'DELETED')
            throw new errorHandler_1.AppError('Product not found', 404);
        res.json({ success: true, data: product, message: 'Product retrieved' });
    }
    catch (error) {
        next(error);
    }
});
router.put('/:id', (0, rbac_1.checkPermission)('products', 'edit'), async (req, res, next) => {
    try {
        const id = req.params.id;
        const data = productSchema.partial().parse(req.body);
        const product = await db_1.prisma.product.update({
            where: { id },
            data: { ...data, basePrice: data.basePrice, weightKg: data.weightKg, technicalSpecs: data.technicalSpecs },
            include: { brand: true, category: true },
        });
        res.json({ success: true, data: product, message: 'Product updated' });
    }
    catch (error) {
        next(error);
    }
});
router.delete('/:id', (0, rbac_1.checkPermission)('products', 'delete'), async (req, res, next) => {
    try {
        const id = req.params.id;
        await db_1.prisma.product.update({ where: { id }, data: { status: 'DELETED' } });
        res.json({ success: true, data: null, message: 'Product deleted' });
    }
    catch (error) {
        next(error);
    }
});
router.put('/:id/toggle-status', (0, rbac_1.checkPermission)('products', 'edit'), async (req, res, next) => {
    try {
        const id = req.params.id;
        const product = await db_1.prisma.product.findUnique({ where: { id } });
        if (!product)
            throw new errorHandler_1.AppError('Product not found', 404);
        const updated = await db_1.prisma.product.update({ where: { id }, data: { isActive: !product.isActive } });
        res.json({ success: true, data: updated, message: `Product ${updated.isActive ? 'activated' : 'deactivated'}` });
    }
    catch (error) {
        next(error);
    }
});
router.get('/:id/pricing/:role', (0, rbac_1.checkPermission)('products', 'view'), async (req, res, next) => {
    try {
        const id = req.params.id;
        const role = req.params.role;
        const zoneId = req.query.zoneId;
        const rules = await db_1.prisma.pricingRule.findMany({
            where: {
                productId: id,
                customerGroup: role,
                isActive: true,
                status: 'ACTIVE',
                validFrom: { lte: new Date() },
                OR: [{ validTo: null }, { validTo: { gte: new Date() } }],
                ...(zoneId ? { OR: [{ zoneId }, { zoneId: null }] } : {}),
            },
            orderBy: [{ zoneId: 'desc' }, { createdAt: 'desc' }],
        });
        const product = await db_1.prisma.product.findUnique({ where: { id } });
        if (!product)
            throw new errorHandler_1.AppError('Product not found', 404);
        const rule = rules[0];
        let computedPrice = Number(product.basePrice);
        if (rule) {
            if (rule.priceType === 'FIXED') {
                computedPrice = Number(rule.priceValue);
            }
            else {
                computedPrice = Number(product.basePrice) * (1 + Number(rule.priceValue) / 100);
            }
        }
        res.json({ success: true, data: { basePrice: product.basePrice, computedPrice, rule }, message: 'Price computed' });
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
//# sourceMappingURL=routes.js.map
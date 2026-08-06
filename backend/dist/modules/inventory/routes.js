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
router.get('/', (0, rbac_1.checkPermission)('inventory', 'view'), async (req, res, next) => {
    try {
        const q = req.query;
        const page = parseInt(q.page || '1', 10);
        const limit = parseInt(q.limit || '20', 10);
        const where = { status: 'ACTIVE' };
        if (q.warehouseId)
            where.warehouseId = q.warehouseId;
        if (q.productId)
            where.productId = q.productId;
        if (q.search)
            where.product = { name: { contains: q.search, mode: 'insensitive' } };
        const [items, total] = await Promise.all([
            db_1.prisma.inventory.findMany({ where: where, include: { product: true, warehouse: true }, skip: (page - 1) * limit, take: limit, orderBy: { updatedAt: 'desc' } }),
            db_1.prisma.inventory.count({ where: where }),
        ]);
        res.json({ success: true, data: items, message: 'Inventory retrieved', meta: { page, limit, total, totalPages: Math.ceil(total / limit) } });
    }
    catch (error) {
        next(error);
    }
});
router.post('/adjust', (0, rbac_1.checkPermission)('inventory', 'edit'), async (req, res, next) => {
    try {
        const data = zod_1.z.object({ productId: zod_1.z.string().uuid(), warehouseId: zod_1.z.string().uuid(), adjustment: zod_1.z.number().int(), reason: zod_1.z.string() }).parse(req.body);
        const inv = await db_1.prisma.inventory.upsert({
            where: { productId_warehouseId: { productId: data.productId, warehouseId: data.warehouseId } },
            create: { productId: data.productId, warehouseId: data.warehouseId, quantityOnHand: Math.max(0, data.adjustment), lastStockDate: new Date(), createdBy: req.user.userId },
            update: { quantityOnHand: { increment: data.adjustment }, lastStockDate: new Date() },
        });
        await db_1.prisma.auditLog.create({
            data: { userId: req.user.userId, action: 'ADJUST', module: 'inventory', recordId: inv.id, newData: { adjustment: data.adjustment, reason: data.reason }, ipAddress: req.ip || null, userAgent: req.headers['user-agent'] || null },
        });
        res.json({ success: true, data: inv, message: 'Stock adjusted' });
    }
    catch (error) {
        next(error);
    }
});
router.post('/transfer', (0, rbac_1.checkPermission)('inventory', 'create'), async (req, res, next) => {
    try {
        const data = zod_1.z.object({ fromWarehouseId: zod_1.z.string().uuid(), toWarehouseId: zod_1.z.string().uuid(), productId: zod_1.z.string().uuid(), quantity: zod_1.z.number().int().positive() }).parse(req.body);
        const sourceInv = await db_1.prisma.inventory.findUnique({ where: { productId_warehouseId: { productId: data.productId, warehouseId: data.fromWarehouseId } } });
        if (!sourceInv || sourceInv.quantityOnHand < data.quantity)
            throw new errorHandler_1.AppError('Insufficient stock for transfer', 400);
        const transfer = await db_1.prisma.stockTransfer.create({
            data: { ...data, transferDate: new Date(), status: 'PENDING', createdBy: req.user.userId },
        });
        res.status(201).json({ success: true, data: transfer, message: 'Transfer request created' });
    }
    catch (error) {
        next(error);
    }
});
router.put('/transfer/:id/approve', (0, rbac_1.checkPermission)('inventory', 'approve'), async (req, res, next) => {
    try {
        const id = req.params.id;
        const transfer = await db_1.prisma.stockTransfer.findUnique({ where: { id } });
        if (!transfer || transfer.status !== 'PENDING')
            throw new errorHandler_1.AppError('Transfer not found or not pending', 400);
        await db_1.prisma.$transaction([
            db_1.prisma.inventory.update({ where: { productId_warehouseId: { productId: transfer.productId, warehouseId: transfer.fromWarehouseId } }, data: { quantityOnHand: { decrement: transfer.quantity } } }),
            db_1.prisma.inventory.upsert({
                where: { productId_warehouseId: { productId: transfer.productId, warehouseId: transfer.toWarehouseId } },
                create: { productId: transfer.productId, warehouseId: transfer.toWarehouseId, quantityOnHand: transfer.quantity, lastStockDate: new Date() },
                update: { quantityOnHand: { increment: transfer.quantity }, lastStockDate: new Date() },
            }),
            db_1.prisma.stockTransfer.update({ where: { id }, data: { status: 'APPROVED', approvedBy: req.user.userId } }),
        ]);
        res.json({ success: true, data: null, message: 'Transfer approved and stock moved' });
    }
    catch (error) {
        next(error);
    }
});
router.get('/low-stock', (0, rbac_1.checkPermission)('inventory', 'view'), async (_req, res, next) => {
    try {
        const items = await db_1.prisma.$queryRaw `
      SELECT i.*, p.name as product_name, p.sku, w.name as warehouse_name
      FROM inventory i
      JOIN products p ON i.product_id = p.id
      JOIN warehouses w ON i.warehouse_id = w.id
      WHERE i.quantity_on_hand <= i.reorder_threshold AND i.status = 'ACTIVE'
      ORDER BY (i.quantity_on_hand::float / NULLIF(i.reorder_threshold, 0)) ASC
    `;
        res.json({ success: true, data: items, message: 'Low stock items retrieved' });
    }
    catch (error) {
        next(error);
    }
});
router.get('/valuation', (0, rbac_1.checkPermission)('inventory', 'view'), async (req, res, next) => {
    try {
        const q = req.query;
        const where = { status: 'ACTIVE' };
        if (q.warehouseId)
            where.warehouseId = q.warehouseId;
        const items = await db_1.prisma.inventory.findMany({
            where: where,
            include: { product: { select: { name: true, sku: true, basePrice: true } }, warehouse: { select: { name: true } } },
        });
        const valuation = items.map((item) => ({
            product: item.product.name,
            sku: item.product.sku,
            warehouse: item.warehouse.name,
            quantity: item.quantityOnHand,
            unitPrice: Number(item.product.basePrice),
            totalValue: item.quantityOnHand * Number(item.product.basePrice),
        }));
        const totalValue = valuation.reduce((sum, v) => sum + v.totalValue, 0);
        res.json({ success: true, data: { items: valuation, totalValue }, message: 'Valuation retrieved' });
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
//# sourceMappingURL=routes.js.map
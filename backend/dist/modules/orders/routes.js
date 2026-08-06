"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const db_1 = require("../../config/db");
const auth_1 = require("../../middleware/auth");
const rbac_1 = require("../../middleware/rbac");
const errorHandler_1 = require("../../middleware/errorHandler");
const gst_calculator_1 = require("../../utils/gst-calculator");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
const orderItemSchema = zod_1.z.object({
    productId: zod_1.z.string().uuid(),
    quantity: zod_1.z.number().int().positive(),
    unitPrice: zod_1.z.number().positive(),
    discountPercent: zod_1.z.number().min(0).max(100).default(0),
    gstRate: zod_1.z.enum(['GST_5', 'GST_12', 'GST_18', 'GST_28']),
    batchNo: zod_1.z.string().optional(),
    schemeId: zod_1.z.string().uuid().optional(),
});
const createOrderSchema = zod_1.z.object({
    buyerId: zod_1.z.string().uuid(),
    sellerId: zod_1.z.string().uuid(),
    zoneId: zod_1.z.string().uuid(),
    warehouseId: zod_1.z.string().uuid().optional(),
    orderType: zod_1.z.enum(['STANDARD', 'VAN_SALE', 'RETURN', 'DRAFT']).default('STANDARD'),
    paymentMode: zod_1.z.enum(['CASH', 'UPI', 'CHEQUE', 'CREDIT', 'NEFT']).default('CREDIT'),
    deliveryAddress: zod_1.z.record(zod_1.z.unknown()).optional(),
    deliveryDate: zod_1.z.string().transform((s) => new Date(s)).optional(),
    notes: zod_1.z.string().optional(),
    isOfflineCreated: zod_1.z.boolean().default(false),
    items: zod_1.z.array(orderItemSchema).min(1),
});
router.get('/', (0, rbac_1.checkPermission)('orders', 'view'), async (req, res, next) => {
    try {
        const q = req.query;
        const page = parseInt(q.page || '1', 10);
        const limit = parseInt(q.limit || '20', 10);
        const where = {};
        if (q.status)
            where.status = q.status;
        if (q.zoneId)
            where.zoneId = q.zoneId;
        if (q.salesmanId)
            where.salesmanId = q.salesmanId;
        if (q.from || q.to) {
            where.createdAt = {};
            if (q.from)
                where.createdAt.gte = new Date(q.from);
            if (q.to)
                where.createdAt.lte = new Date(q.to);
        }
        if (q.search)
            where.orderNumber = { contains: q.search, mode: 'insensitive' };
        const [orders, total] = await Promise.all([
            db_1.prisma.order.findMany({
                where: where,
                include: {
                    buyer: { select: { id: true, name: true, partyCode: true, partyType: { select: { name: true } } } },
                    salesman: { select: { id: true, name: true } },
                    items: {
                        include: {
                            product: { select: { id: true, name: true, sku: true, unitOfMeasure: true, technicalSpecs: true, packSize: true } }
                        }
                    }
                },
                skip: (page - 1) * limit, take: limit, orderBy: { [q.sort || 'createdAt']: q.order || 'desc' },
            }),
            db_1.prisma.order.count({ where: where }),
        ]);
        const formattedOrders = orders.map(order => ({
            id: order.id,
            order_number: order.orderNumber,
            created_at: order.createdAt,
            grand_total: order.grandTotal,
            payment_status: order.paymentStatus,
            status: order.status,
            order_type: order.orderType,
            notes: order.notes,
            approved_by: order.approvedBy,
            created_by: order.createdBy,
            buyer: order.buyer ? {
                id: order.buyer.id,
                name: order.buyer.name,
                party_code: order.buyer.partyCode,
                party_types: order.buyer.partyType ? { name: order.buyer.partyType.name } : null
            } : null,
            salesman: order.salesman,
            order_items: order.items.map(item => ({
                id: item.id,
                product_id: item.productId,
                quantity: item.quantity,
                unit_price: item.unitPrice,
                line_total: item.lineTotal,
                products: item.product ? {
                    name: item.product.name,
                    sku: item.product.sku,
                    unit_of_measure: item.product.unitOfMeasure,
                    technical_specs: item.product.technicalSpecs
                } : null
            }))
        }));
        res.json({ success: true, data: formattedOrders, message: 'Orders retrieved', meta: { page, limit, total, totalPages: Math.ceil(total / limit) } });
    }
    catch (error) {
        next(error);
    }
});
router.post('/', (0, rbac_1.checkPermission)('orders', 'create'), async (req, res, next) => {
    try {
        const data = createOrderSchema.parse(req.body);
        let subtotal = 0, totalDiscount = 0, totalGst = 0;
        const computedItems = data.items.map((item) => {
            const lineSubtotal = item.unitPrice * item.quantity;
            const discountAmt = (lineSubtotal * item.discountPercent) / 100;
            const taxableAmount = lineSubtotal - discountAmt;
            const gst = (0, gst_calculator_1.calculateGst)(taxableAmount, item.gstRate);
            subtotal += lineSubtotal;
            totalDiscount += discountAmt;
            totalGst += gst.totalTax;
            return { ...item, discountAmount: discountAmt, gstAmount: gst.totalTax, lineTotal: gst.totalWithTax };
        });
        const grandTotal = subtotal - totalDiscount + totalGst;
        const order = await db_1.prisma.order.create({
            data: {
                orderNumber: (0, gst_calculator_1.generateOrderNumber)(),
                buyerId: data.buyerId,
                sellerId: data.sellerId,
                salesmanId: req.user.userId,
                zoneId: data.zoneId,
                warehouseId: data.warehouseId,
                orderType: data.orderType,
                paymentMode: data.paymentMode,
                deliveryAddress: data.deliveryAddress,
                deliveryDate: data.deliveryDate,
                notes: data.notes,
                isOfflineCreated: data.isOfflineCreated,
                subtotal,
                discountAmount: totalDiscount,
                gstAmount: totalGst,
                grandTotal,
                status: data.orderType === 'DRAFT' ? 'DRAFT' : 'PENDING',
                paymentStatus: 'UNPAID',
                createdBy: req.user.userId,
                items: {
                    create: computedItems.map((item) => ({
                        productId: item.productId,
                        quantity: item.quantity,
                        unitPrice: item.unitPrice,
                        discountPercent: item.discountPercent,
                        discountAmount: item.discountAmount,
                        gstRate: item.gstRate,
                        gstAmount: item.gstAmount,
                        lineTotal: item.lineTotal,
                        schemeId: item.schemeId,
                        batchNo: item.batchNo,
                    })),
                },
            },
            include: { items: { include: { product: true } }, buyer: { select: { id: true, name: true } } },
        });
        await db_1.prisma.auditLog.create({
            data: { userId: req.user.userId, action: 'CREATE', module: 'orders', recordId: order.id, newData: { orderNumber: order.orderNumber, grandTotal: order.grandTotal }, ipAddress: req.ip || null, userAgent: req.headers['user-agent'] || null },
        });
        res.status(201).json({ success: true, data: order, message: 'Order created' });
    }
    catch (error) {
        next(error);
    }
});
router.get('/:id', (0, rbac_1.checkPermission)('orders', 'view'), async (req, res, next) => {
    try {
        const id = req.params.id;
        const order = await db_1.prisma.order.findUnique({
            where: { id },
            include: { items: { include: { product: true } }, buyer: true, seller: true, salesman: true, zone: true, payments: true },
        });
        if (!order)
            throw new errorHandler_1.AppError('Order not found', 404);
        res.json({ success: true, data: order, message: 'Order retrieved' });
    }
    catch (error) {
        next(error);
    }
});
router.post('/:id/approve', (0, rbac_1.checkPermission)('orders', 'approve'), async (req, res, next) => {
    try {
        const id = req.params.id;
        const order = await db_1.prisma.order.findUnique({ where: { id } });
        if (!order)
            throw new errorHandler_1.AppError('Order not found', 404);
        if (order.status !== 'PENDING')
            throw new errorHandler_1.AppError('Order is not pending approval', 400);
        const updated = await db_1.prisma.order.update({
            where: { id },
            data: { status: 'APPROVED', approvedBy: req.user.userId, approvalTime: new Date() },
        });
        res.json({ success: true, data: updated, message: 'Order approved' });
    }
    catch (error) {
        next(error);
    }
});
router.post('/:id/dispatch', (0, rbac_1.checkPermission)('orders', 'edit'), async (req, res, next) => {
    try {
        const id = req.params.id;
        const order = await db_1.prisma.order.findUnique({ where: { id } });
        if (!order || order.status !== 'APPROVED')
            throw new errorHandler_1.AppError('Order must be approved before dispatch', 400);
        const updated = await db_1.prisma.order.update({ where: { id }, data: { status: 'DISPATCHED' } });
        res.json({ success: true, data: updated, message: 'Order dispatched' });
    }
    catch (error) {
        next(error);
    }
});
router.post('/:id/deliver', (0, rbac_1.checkPermission)('orders', 'edit'), async (req, res, next) => {
    try {
        const id = req.params.id;
        const order = await db_1.prisma.order.findUnique({ where: { id } });
        if (!order || order.status !== 'DISPATCHED')
            throw new errorHandler_1.AppError('Order must be dispatched before delivery', 400);
        const updated = await db_1.prisma.order.update({ where: { id }, data: { status: 'DELIVERED' } });
        await db_1.prisma.outstandingLedger.create({
            data: { userId: order.buyerId, orderId: order.id, debit: order.grandTotal, credit: 0, balance: order.grandTotal, transactionDate: new Date(), narration: `Order ${order.orderNumber} delivered`, fiscalYear: (0, gst_calculator_1.getCurrentFiscalYear)() },
        });
        res.json({ success: true, data: updated, message: 'Order delivered' });
    }
    catch (error) {
        next(error);
    }
});
router.post('/:id/return', (0, rbac_1.checkPermission)('orders', 'edit'), async (req, res, next) => {
    try {
        const id = req.params.id;
        const order = await db_1.prisma.order.findUnique({ where: { id } });
        if (!order)
            throw new errorHandler_1.AppError('Order not found', 404);
        const updated = await db_1.prisma.order.update({ where: { id }, data: { status: 'RETURNED' } });
        res.json({ success: true, data: updated, message: 'Order returned' });
    }
    catch (error) {
        next(error);
    }
});
router.delete('/:id', (0, rbac_1.checkPermission)('orders', 'delete'), async (req, res, next) => {
    try {
        const id = req.params.id;
        const order = await db_1.prisma.order.findUnique({ where: { id } });
        if (!order)
            throw new errorHandler_1.AppError('Order not found', 404);
        if (!['DRAFT', 'PENDING'].includes(order.status))
            throw new errorHandler_1.AppError('Can only cancel draft or pending orders', 400);
        const updated = await db_1.prisma.order.update({ where: { id }, data: { status: 'CANCELLED' } });
        res.json({ success: true, data: updated, message: 'Order cancelled' });
    }
    catch (error) {
        next(error);
    }
});
router.post('/sync', (0, rbac_1.checkPermission)('orders', 'create'), async (req, res, next) => {
    try {
        const { orders } = zod_1.z.object({ orders: zod_1.z.array(createOrderSchema) }).parse(req.body);
        const results = await db_1.prisma.$transaction(async (tx) => {
            const synced = [];
            for (const orderData of orders) {
                let subtotal = 0, totalDiscount = 0, totalGst = 0;
                const computedItems = orderData.items.map((item) => {
                    const lineSubtotal = item.unitPrice * item.quantity;
                    const discountAmt = (lineSubtotal * item.discountPercent) / 100;
                    const taxableAmount = lineSubtotal - discountAmt;
                    const gst = (0, gst_calculator_1.calculateGst)(taxableAmount, item.gstRate);
                    subtotal += lineSubtotal;
                    totalDiscount += discountAmt;
                    totalGst += gst.totalTax;
                    return { ...item, discountAmount: discountAmt, gstAmount: gst.totalTax, lineTotal: gst.totalWithTax };
                });
                const grandTotal = subtotal - totalDiscount + totalGst;
                const order = await tx.order.create({
                    data: {
                        orderNumber: (0, gst_calculator_1.generateOrderNumber)(),
                        buyerId: orderData.buyerId, sellerId: orderData.sellerId, salesmanId: req.user.userId,
                        zoneId: orderData.zoneId, warehouseId: orderData.warehouseId, orderType: orderData.orderType, paymentMode: orderData.paymentMode,
                        deliveryAddress: orderData.deliveryAddress, notes: orderData.notes,
                        isOfflineCreated: true, syncedAt: new Date(), subtotal, discountAmount: totalDiscount, gstAmount: totalGst, grandTotal,
                        status: 'PENDING', paymentStatus: 'UNPAID', createdBy: req.user.userId,
                        items: { create: computedItems.map((item) => ({ productId: item.productId, quantity: item.quantity, unitPrice: item.unitPrice, discountPercent: item.discountPercent, discountAmount: item.discountAmount, gstRate: item.gstRate, gstAmount: item.gstAmount, lineTotal: item.lineTotal, schemeId: item.schemeId, batchNo: item.batchNo })) },
                    },
                });
                synced.push(order);
            }
            return synced;
        });
        res.json({ success: true, data: results, message: `${results.length} orders synced` });
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
//# sourceMappingURL=routes.js.map
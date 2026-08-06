"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const db_1 = require("../../config/db");
const auth_1 = require("../../middleware/auth");
const rbac_1 = require("../../middleware/rbac");
const gst_calculator_1 = require("../../utils/gst-calculator");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
const paymentSchema = zod_1.z.object({
    orderId: zod_1.z.string().uuid(),
    amount: zod_1.z.number().positive(),
    paymentMode: zod_1.z.enum(['CASH', 'UPI', 'CHEQUE', 'CREDIT', 'NEFT']),
    referenceNumber: zod_1.z.string().optional(),
    paymentDate: zod_1.z.string().transform((s) => new Date(s)),
});
router.get('/', (0, rbac_1.checkPermission)('payments', 'view'), async (req, res, next) => {
    try {
        const q = req.query;
        const page = parseInt(q.page || '1', 10);
        const limit = parseInt(q.limit || '20', 10);
        const [payments, total] = await Promise.all([
            db_1.prisma.payment.findMany({
                include: { order: { select: { orderNumber: true } }, payer: { select: { id: true, name: true } } },
                skip: (page - 1) * limit, take: limit, orderBy: { paymentDate: 'desc' },
            }),
            db_1.prisma.payment.count(),
        ]);
        res.json({ success: true, data: payments, message: 'Payments retrieved', meta: { page, limit, total, totalPages: Math.ceil(total / limit) } });
    }
    catch (error) {
        next(error);
    }
});
router.post('/', (0, rbac_1.checkPermission)('payments', 'create'), async (req, res, next) => {
    try {
        const data = paymentSchema.parse(req.body);
        const order = await db_1.prisma.order.findUnique({ where: { id: data.orderId } });
        if (!order) {
            res.status(404).json({ success: false, data: null, message: 'Order not found' });
            return;
        }
        const payment = await db_1.prisma.payment.create({
            data: { ...data, payerId: order.buyerId, createdBy: req.user.userId },
        });
        const totalPaid = await db_1.prisma.payment.aggregate({ where: { orderId: data.orderId }, _sum: { amount: true } });
        const paidAmount = Number(totalPaid._sum.amount || 0);
        const orderTotal = Number(order.grandTotal);
        await db_1.prisma.order.update({
            where: { id: data.orderId },
            data: { paymentStatus: paidAmount >= orderTotal ? 'PAID' : 'PARTIAL' },
        });
        await db_1.prisma.outstandingLedger.create({
            data: { userId: order.buyerId, orderId: order.id, debit: 0, credit: data.amount, balance: orderTotal - paidAmount, transactionDate: data.paymentDate, narration: `Payment received for ${order.orderNumber}`, fiscalYear: (0, gst_calculator_1.getCurrentFiscalYear)() },
        });
        res.status(201).json({ success: true, data: payment, message: 'Payment recorded' });
    }
    catch (error) {
        next(error);
    }
});
router.get('/outstanding', (0, rbac_1.checkPermission)('payments', 'view'), async (req, res, next) => {
    try {
        const q = req.query;
        const where = {};
        if (q.userId)
            where.userId = q.userId;
        const ledger = await db_1.prisma.outstandingLedger.findMany({
            where: where,
            include: { user: { select: { id: true, name: true, phone: true } }, order: { select: { orderNumber: true } } },
            orderBy: { transactionDate: 'desc' },
            take: 200,
        });
        res.json({ success: true, data: ledger, message: 'Outstanding ledger retrieved' });
    }
    catch (error) {
        next(error);
    }
});
router.get('/collection-report', (0, rbac_1.checkPermission)('payments', 'view'), async (req, res, next) => {
    try {
        const { from, to, zone } = req.query;
        const where = {};
        if (from || to) {
            where.paymentDate = {};
            if (from)
                where.paymentDate.gte = new Date(from);
            if (to)
                where.paymentDate.lte = new Date(to);
        }
        if (zone)
            where.order = { zoneId: zone };
        const payments = await db_1.prisma.payment.findMany({
            where: where,
            include: { order: { select: { orderNumber: true, zoneId: true } }, payer: { select: { name: true } } },
            orderBy: { paymentDate: 'desc' },
        });
        const total = payments.reduce((sum, p) => sum + Number(p.amount), 0);
        res.json({ success: true, data: { payments, totalCollection: total }, message: 'Collection report generated' });
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
//# sourceMappingURL=routes.js.map
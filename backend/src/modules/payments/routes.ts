import { Router } from 'express';
import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/db';
import { authenticate } from '../../middleware/auth';
import { checkPermission } from '../../middleware/rbac';
import { AuthRequest, PaginationQuery } from '../../types';
import { getCurrentFiscalYear } from '../../utils/gst-calculator';

const router = Router();
router.use(authenticate);

const paymentSchema = z.object({
  orderId: z.string().uuid(),
  amount: z.number().positive(),
  paymentMode: z.enum(['CASH', 'UPI', 'CHEQUE', 'CREDIT', 'NEFT']),
  referenceNumber: z.string().optional(),
  paymentDate: z.string().transform((s) => new Date(s)),
});

router.get('/', checkPermission('payments', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const q = req.query as PaginationQuery;
    const page = parseInt(q.page || '1', 10);
    const limit = parseInt(q.limit || '20', 10);

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        include: { order: { select: { orderNumber: true } }, payer: { select: { id: true, name: true } } },
        skip: (page - 1) * limit, take: limit, orderBy: { paymentDate: 'desc' },
      }),
      prisma.payment.count(),
    ]);

    res.json({ success: true, data: payments, message: 'Payments retrieved', meta: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) { next(error); }
});

router.post('/', checkPermission('payments', 'create'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = paymentSchema.parse(req.body);
    const order = await prisma.order.findUnique({ where: { id: data.orderId } });
    if (!order) { res.status(404).json({ success: false, data: null, message: 'Order not found' }); return; }

    const payment = await prisma.payment.create({
      data: { ...data, payerId: order.buyerId, createdBy: req.user!.userId },
    });

    const totalPaid = await prisma.payment.aggregate({ where: { orderId: data.orderId }, _sum: { amount: true } });
    const paidAmount = Number(totalPaid._sum.amount || 0);
    const orderTotal = Number(order.grandTotal);

    await prisma.order.update({
      where: { id: data.orderId },
      data: { paymentStatus: paidAmount >= orderTotal ? 'PAID' : 'PARTIAL' },
    });

    await prisma.outstandingLedger.create({
      data: { userId: order.buyerId, orderId: order.id, debit: 0, credit: data.amount, balance: orderTotal - paidAmount, transactionDate: data.paymentDate, narration: `Payment received for ${order.orderNumber}`, fiscalYear: getCurrentFiscalYear() },
    });

    res.status(201).json({ success: true, data: payment, message: 'Payment recorded' });
  } catch (error) { next(error); }
});

router.get('/outstanding', checkPermission('payments', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const q = req.query as { userId?: string };
    const where: Record<string, unknown> = {};
    if (q.userId) where.userId = q.userId;

    const ledger = await prisma.outstandingLedger.findMany({
      where: where as never,
      include: { user: { select: { id: true, name: true, phone: true } }, order: { select: { orderNumber: true } } },
      orderBy: { transactionDate: 'desc' },
      take: 200,
    });

    res.json({ success: true, data: ledger, message: 'Outstanding ledger retrieved' });
  } catch (error) { next(error); }
});

router.get('/collection-report', checkPermission('payments', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { from, to, zone } = req.query as { from?: string; to?: string; zone?: string };
    const where: Record<string, unknown> = {};
    if (from || to) {
      where.paymentDate = {};
      if (from) (where.paymentDate as Record<string, unknown>).gte = new Date(from);
      if (to) (where.paymentDate as Record<string, unknown>).lte = new Date(to);
    }
    if (zone) where.order = { zoneId: zone };

    const payments = await prisma.payment.findMany({
      where: where as never,
      include: { order: { select: { orderNumber: true, zoneId: true } }, payer: { select: { name: true } } },
      orderBy: { paymentDate: 'desc' },
    });

    const total = payments.reduce((sum, p) => sum + Number(p.amount), 0);
    res.json({ success: true, data: { payments, totalCollection: total }, message: 'Collection report generated' });
  } catch (error) { next(error); }
});

export default router;

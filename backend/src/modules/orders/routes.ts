import { Router } from 'express';
import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/db';
import { authenticate } from '../../middleware/auth';
import { checkPermission } from '../../middleware/rbac';
import { AuthRequest, PaginationQuery } from '../../types';
import { AppError } from '../../middleware/errorHandler';
import { generateOrderNumber, calculateGst, getCurrentFiscalYear } from '../../utils/gst-calculator';
import { GstRate } from '@prisma/client';

const router = Router();
router.use(authenticate);

const orderItemSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().positive(),
  unitPrice: z.number().positive(),
  discountPercent: z.number().min(0).max(100).default(0),
  gstRate: z.enum(['GST_5', 'GST_12', 'GST_18', 'GST_28']),
  batchNo: z.string().optional(),
  schemeId: z.string().uuid().optional(),
});

const createOrderSchema = z.object({
  buyerId: z.string().uuid(),
  sellerId: z.string().uuid(),
  zoneId: z.string().uuid(),
  warehouseId: z.string().uuid().optional(),
  orderType: z.enum(['STANDARD', 'VAN_SALE', 'RETURN', 'DRAFT']).default('STANDARD'),
  paymentMode: z.enum(['CASH', 'UPI', 'CHEQUE', 'CREDIT', 'NEFT']).default('CREDIT'),
  deliveryAddress: z.record(z.unknown()).optional(),
  deliveryDate: z.string().transform((s) => new Date(s)).optional(),
  notes: z.string().optional(),
  isOfflineCreated: z.boolean().default(false),
  items: z.array(orderItemSchema).min(1),
});

router.get('/', checkPermission('orders', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const q = req.query as PaginationQuery & { status?: string; zoneId?: string; salesmanId?: string; from?: string; to?: string };
    const page = parseInt(q.page || '1', 10);
    const limit = parseInt(q.limit || '20', 10);

    const where: Record<string, unknown> = {};
    if (q.status) where.status = q.status;
    if (q.zoneId) where.zoneId = q.zoneId;
    if (q.salesmanId) where.salesmanId = q.salesmanId;
    if (q.from || q.to) {
      where.createdAt = {};
      if (q.from) (where.createdAt as Record<string, unknown>).gte = new Date(q.from);
      if (q.to) (where.createdAt as Record<string, unknown>).lte = new Date(q.to);
    }
    if (q.search) where.orderNumber = { contains: q.search, mode: 'insensitive' };

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where: where as never,
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
      prisma.order.count({ where: where as never }),
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
  } catch (error) { next(error); }
});

router.post('/', checkPermission('orders', 'create'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = createOrderSchema.parse(req.body);
    let subtotal = 0, totalDiscount = 0, totalGst = 0;

    const computedItems = data.items.map((item) => {
      const lineSubtotal = item.unitPrice * item.quantity;
      const discountAmt = (lineSubtotal * item.discountPercent) / 100;
      const taxableAmount = lineSubtotal - discountAmt;
      const gst = calculateGst(taxableAmount, item.gstRate as GstRate);
      subtotal += lineSubtotal;
      totalDiscount += discountAmt;
      totalGst += gst.totalTax;
      return { ...item, discountAmount: discountAmt, gstAmount: gst.totalTax, lineTotal: gst.totalWithTax };
    });

    const grandTotal = subtotal - totalDiscount + totalGst;

    const order = await prisma.order.create({
      data: {
        orderNumber: generateOrderNumber(),
        buyerId: data.buyerId,
        sellerId: data.sellerId,
        salesmanId: req.user!.userId,
        zoneId: data.zoneId,
        warehouseId: data.warehouseId,
        orderType: data.orderType,
        paymentMode: data.paymentMode,
        deliveryAddress: data.deliveryAddress as any,
        deliveryDate: data.deliveryDate,
        notes: data.notes,
        isOfflineCreated: data.isOfflineCreated,
        subtotal,
        discountAmount: totalDiscount,
        gstAmount: totalGst,
        grandTotal,
        status: data.orderType === 'DRAFT' ? 'DRAFT' : 'PENDING',
        paymentStatus: 'UNPAID',
        createdBy: req.user!.userId,
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

    await prisma.auditLog.create({
      data: { userId: req.user!.userId, action: 'CREATE', module: 'orders', recordId: order.id, newData: { orderNumber: order.orderNumber, grandTotal: order.grandTotal }, ipAddress: req.ip || null, userAgent: req.headers['user-agent'] || null },
    });

    res.status(201).json({ success: true, data: order, message: 'Order created' });
  } catch (error) { next(error); }
});

router.get('/:id', checkPermission('orders', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const order = await prisma.order.findUnique({
      where: { id },
      include: { items: { include: { product: true } }, buyer: true, seller: true, salesman: true, zone: true, payments: true },
    });
    if (!order) throw new AppError('Order not found', 404);
    res.json({ success: true, data: order, message: 'Order retrieved' });
  } catch (error) { next(error); }
});

router.post('/:id/approve', checkPermission('orders', 'approve'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) throw new AppError('Order not found', 404);
    if (order.status !== 'PENDING') throw new AppError('Order is not pending approval', 400);

    const updated = await prisma.order.update({
      where: { id },
      data: { status: 'APPROVED', approvedBy: req.user!.userId, approvalTime: new Date() },
    });

    res.json({ success: true, data: updated, message: 'Order approved' });
  } catch (error) { next(error); }
});

router.post('/:id/dispatch', checkPermission('orders', 'edit'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const order = await prisma.order.findUnique({ where: { id } });
    if (!order || order.status !== 'APPROVED') throw new AppError('Order must be approved before dispatch', 400);
    const updated = await prisma.order.update({ where: { id }, data: { status: 'DISPATCHED' } });
    res.json({ success: true, data: updated, message: 'Order dispatched' });
  } catch (error) { next(error); }
});

router.post('/:id/deliver', checkPermission('orders', 'edit'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const order = await prisma.order.findUnique({ where: { id } });
    if (!order || order.status !== 'DISPATCHED') throw new AppError('Order must be dispatched before delivery', 400);
    const updated = await prisma.order.update({ where: { id }, data: { status: 'DELIVERED' } });

    await prisma.outstandingLedger.create({
      data: { userId: order.buyerId, orderId: order.id, debit: order.grandTotal, credit: 0, balance: order.grandTotal, transactionDate: new Date(), narration: `Order ${order.orderNumber} delivered`, fiscalYear: getCurrentFiscalYear() },
    });

    res.json({ success: true, data: updated, message: 'Order delivered' });
  } catch (error) { next(error); }
});

router.post('/:id/return', checkPermission('orders', 'edit'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) throw new AppError('Order not found', 404);
    const updated = await prisma.order.update({ where: { id }, data: { status: 'RETURNED' } });
    res.json({ success: true, data: updated, message: 'Order returned' });
  } catch (error) { next(error); }
});

router.delete('/:id', checkPermission('orders', 'delete'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const order = await prisma.order.findUnique({ where: { id } });
    if (!order) throw new AppError('Order not found', 404);
    if (!['DRAFT', 'PENDING'].includes(order.status)) throw new AppError('Can only cancel draft or pending orders', 400);
    const updated = await prisma.order.update({ where: { id }, data: { status: 'CANCELLED' } });
    res.json({ success: true, data: updated, message: 'Order cancelled' });
  } catch (error) { next(error); }
});

router.post('/sync', checkPermission('orders', 'create'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { orders } = z.object({ orders: z.array(createOrderSchema) }).parse(req.body);

    const results = await prisma.$transaction(async (tx) => {
      const synced = [];
      for (const orderData of orders) {
        let subtotal = 0, totalDiscount = 0, totalGst = 0;
        const computedItems = orderData.items.map((item) => {
          const lineSubtotal = item.unitPrice * item.quantity;
          const discountAmt = (lineSubtotal * item.discountPercent) / 100;
          const taxableAmount = lineSubtotal - discountAmt;
          const gst = calculateGst(taxableAmount, item.gstRate as GstRate);
          subtotal += lineSubtotal;
          totalDiscount += discountAmt;
          totalGst += gst.totalTax;
          return { ...item, discountAmount: discountAmt, gstAmount: gst.totalTax, lineTotal: gst.totalWithTax };
        });
        const grandTotal = subtotal - totalDiscount + totalGst;

        const order = await tx.order.create({
          data: {
            orderNumber: generateOrderNumber(),
            buyerId: orderData.buyerId, sellerId: orderData.sellerId, salesmanId: req.user!.userId,
            zoneId: orderData.zoneId, warehouseId: orderData.warehouseId, orderType: orderData.orderType, paymentMode: orderData.paymentMode,
            deliveryAddress: orderData.deliveryAddress as any, notes: orderData.notes,
            isOfflineCreated: true, syncedAt: new Date(), subtotal, discountAmount: totalDiscount, gstAmount: totalGst, grandTotal,
            status: 'PENDING', paymentStatus: 'UNPAID', createdBy: req.user!.userId,
            items: { create: computedItems.map((item) => ({ productId: item.productId, quantity: item.quantity, unitPrice: item.unitPrice, discountPercent: item.discountPercent, discountAmount: item.discountAmount, gstRate: item.gstRate, gstAmount: item.gstAmount, lineTotal: item.lineTotal, schemeId: item.schemeId, batchNo: item.batchNo })) },
          },
        });
        synced.push(order);
      }
      return synced;
    });

    res.json({ success: true, data: results, message: `${results.length} orders synced` });
  } catch (error) { next(error); }
});

export default router;

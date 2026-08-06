import { Router } from 'express';
import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/db';
import { authenticate } from '../../middleware/auth';
import { checkPermission } from '../../middleware/rbac';
import { AuthRequest, PaginationQuery } from '../../types';
import { AppError } from '../../middleware/errorHandler';

const router = Router();
router.use(authenticate);

router.get('/', checkPermission('inventory', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const q = req.query as PaginationQuery & { warehouseId?: string; productId?: string };
    const page = parseInt(q.page || '1', 10);
    const limit = parseInt(q.limit || '20', 10);
    const where: Record<string, unknown> = { status: 'ACTIVE' };
    if (q.warehouseId) where.warehouseId = q.warehouseId;
    if (q.productId) where.productId = q.productId;
    if (q.search) where.product = { name: { contains: q.search, mode: 'insensitive' } };

    const [items, total] = await Promise.all([
      prisma.inventory.findMany({ where: where as never, include: { product: true, warehouse: true }, skip: (page - 1) * limit, take: limit, orderBy: { updatedAt: 'desc' } }),
      prisma.inventory.count({ where: where as never }),
    ]);

    res.json({ success: true, data: items, message: 'Inventory retrieved', meta: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) { next(error); }
});

router.post('/adjust', checkPermission('inventory', 'edit'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = z.object({ productId: z.string().uuid(), warehouseId: z.string().uuid(), adjustment: z.number().int(), reason: z.string() }).parse(req.body);

    const inv = await prisma.inventory.upsert({
      where: { productId_warehouseId: { productId: data.productId, warehouseId: data.warehouseId } },
      create: { productId: data.productId, warehouseId: data.warehouseId, quantityOnHand: Math.max(0, data.adjustment), lastStockDate: new Date(), createdBy: req.user!.userId },
      update: { quantityOnHand: { increment: data.adjustment }, lastStockDate: new Date() },
    });

    await prisma.auditLog.create({
      data: { userId: req.user!.userId, action: 'ADJUST', module: 'inventory', recordId: inv.id, newData: { adjustment: data.adjustment, reason: data.reason }, ipAddress: req.ip || null, userAgent: req.headers['user-agent'] || null },
    });

    res.json({ success: true, data: inv, message: 'Stock adjusted' });
  } catch (error) { next(error); }
});

router.post('/transfer', checkPermission('inventory', 'create'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = z.object({ fromWarehouseId: z.string().uuid(), toWarehouseId: z.string().uuid(), productId: z.string().uuid(), quantity: z.number().int().positive() }).parse(req.body);

    const sourceInv = await prisma.inventory.findUnique({ where: { productId_warehouseId: { productId: data.productId, warehouseId: data.fromWarehouseId } } });
    if (!sourceInv || sourceInv.quantityOnHand < data.quantity) throw new AppError('Insufficient stock for transfer', 400);

    const transfer = await prisma.stockTransfer.create({
      data: { ...data, transferDate: new Date(), status: 'PENDING', createdBy: req.user!.userId },
    });

    res.status(201).json({ success: true, data: transfer, message: 'Transfer request created' });
  } catch (error) { next(error); }
});

router.put('/transfer/:id/approve', checkPermission('inventory', 'approve'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const transfer = await prisma.stockTransfer.findUnique({ where: { id } });
    if (!transfer || transfer.status !== 'PENDING') throw new AppError('Transfer not found or not pending', 400);

    await prisma.$transaction([
      prisma.inventory.update({ where: { productId_warehouseId: { productId: transfer.productId, warehouseId: transfer.fromWarehouseId } }, data: { quantityOnHand: { decrement: transfer.quantity } } }),
      prisma.inventory.upsert({
        where: { productId_warehouseId: { productId: transfer.productId, warehouseId: transfer.toWarehouseId } },
        create: { productId: transfer.productId, warehouseId: transfer.toWarehouseId, quantityOnHand: transfer.quantity, lastStockDate: new Date() },
        update: { quantityOnHand: { increment: transfer.quantity }, lastStockDate: new Date() },
      }),
      prisma.stockTransfer.update({ where: { id }, data: { status: 'APPROVED', approvedBy: req.user!.userId } }),
    ]);

    res.json({ success: true, data: null, message: 'Transfer approved and stock moved' });
  } catch (error) { next(error); }
});

router.get('/low-stock', checkPermission('inventory', 'view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const items = await prisma.$queryRaw`
      SELECT i.*, p.name as product_name, p.sku, w.name as warehouse_name
      FROM inventory i
      JOIN products p ON i.product_id = p.id
      JOIN warehouses w ON i.warehouse_id = w.id
      WHERE i.quantity_on_hand <= i.reorder_threshold AND i.status = 'ACTIVE'
      ORDER BY (i.quantity_on_hand::float / NULLIF(i.reorder_threshold, 0)) ASC
    `;
    res.json({ success: true, data: items, message: 'Low stock items retrieved' });
  } catch (error) { next(error); }
});

router.get('/valuation', checkPermission('inventory', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const q = req.query as { warehouseId?: string };
    const where: Record<string, unknown> = { status: 'ACTIVE' };
    if (q.warehouseId) where.warehouseId = q.warehouseId;

    const items = await prisma.inventory.findMany({
      where: where as never,
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
  } catch (error) { next(error); }
});

export default router;

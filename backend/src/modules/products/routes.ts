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

const productSchema = z.object({
  sku: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  brandId: z.string().uuid(),
  categoryId: z.string().uuid(),
  unitType: z.enum(['KG', 'LITRE', 'BAG', 'PIECE', 'SET']),
  basePrice: z.number().positive(),
  description: z.string().optional(),
  technicalSpecs: z.record(z.unknown()).optional(),
  isZoneRestricted: z.boolean().optional(),
  weightKg: z.number().positive().optional(),
  hsnCode: z.string().min(4).max(8),
  gstRate: z.enum(['GST_5', 'GST_12', 'GST_18', 'GST_28']),
  sortOrder: z.number().int().optional(),
});

router.get('/', checkPermission('products', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const q = req.query as PaginationQuery & { zoneId?: string; categoryId?: string; brandId?: string; status?: string };
    const page = parseInt(q.page || '1', 10);
    const limit = parseInt(q.limit || '20', 10);

    const where: Record<string, unknown> = { status: { not: 'DELETED' } };
    if (q.categoryId) where.categoryId = q.categoryId;
    if (q.brandId) where.brandId = q.brandId;
    if (q.search) where.OR = [
      { name: { contains: q.search, mode: 'insensitive' } },
      { sku: { contains: q.search, mode: 'insensitive' } },
    ];

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where: where as never,
        include: { brand: true, category: true },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { [q.sort || 'createdAt']: q.order || 'desc' },
      }),
      prisma.product.count({ where: where as never }),
    ]);

    res.json({
      success: true, data: products, message: 'Products retrieved',
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) { next(error); }
});

router.post('/', checkPermission('products', 'create'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = productSchema.parse(req.body);
    const product = await prisma.product.create({
      data: { ...data, basePrice: data.basePrice, weightKg: data.weightKg, technicalSpecs: data.technicalSpecs as any, createdBy: req.user!.userId },
      include: { brand: true, category: true },
    });

    await prisma.auditLog.create({
      data: { userId: req.user!.userId, action: 'CREATE', module: 'products', recordId: product.id, newData: { sku: product.sku, name: product.name }, ipAddress: req.ip || null, userAgent: req.headers['user-agent'] || null },
    });

    res.status(201).json({ success: true, data: product, message: 'Product created' });
  } catch (error) { next(error); }
});

router.get('/:id', checkPermission('products', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const product = await prisma.product.findUnique({
      where: { id },
      include: { brand: true, category: true, pricingRules: { where: { isActive: true } }, inventory: { include: { warehouse: true } } },
    });
    if (!product || product.status === 'DELETED') throw new AppError('Product not found', 404);
    res.json({ success: true, data: product, message: 'Product retrieved' });
  } catch (error) { next(error); }
});

router.put('/:id', checkPermission('products', 'edit'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const data = productSchema.partial().parse(req.body);
    const product = await prisma.product.update({
      where: { id },
      data: { ...data, basePrice: data.basePrice, weightKg: data.weightKg, technicalSpecs: data.technicalSpecs as any },
      include: { brand: true, category: true },
    });
    res.json({ success: true, data: product, message: 'Product updated' });
  } catch (error) { next(error); }
});

router.delete('/:id', checkPermission('products', 'delete'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    await prisma.product.update({ where: { id }, data: { status: 'DELETED' } });
    res.json({ success: true, data: null, message: 'Product deleted' });
  } catch (error) { next(error); }
});

router.put('/:id/toggle-status', checkPermission('products', 'edit'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const product = await prisma.product.findUnique({ where: { id } });
    if (!product) throw new AppError('Product not found', 404);
    const updated = await prisma.product.update({ where: { id }, data: { isActive: !product.isActive } });
    res.json({ success: true, data: updated, message: `Product ${updated.isActive ? 'activated' : 'deactivated'}` });
  } catch (error) { next(error); }
});

router.get('/:id/pricing/:role', checkPermission('products', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const role = req.params.role as string;
    const zoneId = req.query.zoneId as string | undefined;

    const rules = await prisma.pricingRule.findMany({
      where: {
        productId: id,
        customerGroup: role as never,
        isActive: true,
        status: 'ACTIVE',
        validFrom: { lte: new Date() },
        OR: [{ validTo: null }, { validTo: { gte: new Date() } }],
        ...(zoneId ? { OR: [{ zoneId }, { zoneId: null }] } : {}),
      },
      orderBy: [{ zoneId: 'desc' }, { createdAt: 'desc' }],
    });

    const product = await prisma.product.findUnique({ where: { id } });
    if (!product) throw new AppError('Product not found', 404);

    const rule = rules[0];
    let computedPrice = Number(product.basePrice);
    if (rule) {
      if (rule.priceType === 'FIXED') {
        computedPrice = Number(rule.priceValue);
      } else {
        computedPrice = Number(product.basePrice) * (1 + Number(rule.priceValue) / 100);
      }
    }

    res.json({ success: true, data: { basePrice: product.basePrice, computedPrice, rule }, message: 'Price computed' });
  } catch (error) { next(error); }
});

export default router;

import { Router } from 'express';
import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/db';
import { authenticate } from '../../middleware/auth';
import { checkPermission } from '../../middleware/rbac';
import { AuthRequest, PaginationQuery } from '../../types';

const router = Router();
router.use(authenticate);

const pricingRuleSchema = z.object({
  productId: z.string().uuid(),
  zoneId: z.string().uuid().nullable().optional(),
  customerGroup: z.enum(['DISTRIBUTOR', 'SUB_DISTRIBUTOR', 'RETAILER', 'DIRECT']),
  priceType: z.enum(['FIXED', 'MARGIN_PERCENT']),
  priceValue: z.number().positive(),
  minMarginFloor: z.number().optional(),
  maxMarginCeiling: z.number().optional(),
  validFrom: z.string().transform((s) => new Date(s)),
  validTo: z.string().transform((s) => new Date(s)).nullable().optional(),
  changeReason: z.string().min(1),
});

const slabSchema = z.object({
  productId: z.string().uuid(),
  customerGroup: z.enum(['DISTRIBUTOR', 'SUB_DISTRIBUTOR', 'RETAILER', 'DIRECT']),
  minQty: z.number().int().positive(),
  maxQty: z.number().int().positive().nullable().optional(),
  slabPrice: z.number().positive(),
  zoneId: z.string().uuid().nullable().optional(),
});

const computeSchema = z.object({
  productId: z.string().uuid(),
  role: z.enum(['DISTRIBUTOR', 'SUB_DISTRIBUTOR', 'RETAILER', 'DIRECT']),
  quantity: z.number().int().positive(),
  zoneId: z.string().uuid().optional(),
});

router.get('/rules', checkPermission('pricing', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const q = req.query as PaginationQuery & { productId?: string };
    const page = parseInt(q.page || '1', 10);
    const limit = parseInt(q.limit || '20', 10);
    const where: Record<string, unknown> = { status: 'ACTIVE' };
    if (q.productId) where.productId = q.productId;

    const [rules, total] = await Promise.all([
      prisma.pricingRule.findMany({ where: where as never, include: { product: true, zone: true }, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' } }),
      prisma.pricingRule.count({ where: where as never }),
    ]);

    res.json({ success: true, data: rules, message: 'Pricing rules retrieved', meta: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) { next(error); }
});

router.post('/rules', checkPermission('pricing', 'create'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { changeReason, ...data } = pricingRuleSchema.parse(req.body);
    const rule = await prisma.pricingRule.create({
      data: { ...data, zoneId: data.zoneId ?? null, validTo: data.validTo ?? null, createdBy: req.user!.userId },
    });

    await prisma.pricingAuditLog.create({
      data: { pricingRuleId: rule.id, changedBy: req.user!.userId, oldValue: {}, newValue: data as never, changeReason },
    });

    res.status(201).json({ success: true, data: rule, message: 'Pricing rule created' });
  } catch (error) { next(error); }
});

router.put('/rules/:id', checkPermission('pricing', 'edit'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const { changeReason, ...data } = pricingRuleSchema.partial().extend({ changeReason: z.string().min(1) }).parse(req.body);
    const old = await prisma.pricingRule.findUnique({ where: { id } });
    const rule = await prisma.pricingRule.update({ where: { id }, data: data as never });

    await prisma.pricingAuditLog.create({
      data: { pricingRuleId: rule.id, changedBy: req.user!.userId, oldValue: old as never, newValue: data as never, changeReason },
    });

    res.json({ success: true, data: rule, message: 'Pricing rule updated' });
  } catch (error) { next(error); }
});

router.delete('/rules/:id', checkPermission('pricing', 'delete'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    await prisma.pricingRule.update({ where: { id }, data: { status: 'DELETED' } });
    res.json({ success: true, data: null, message: 'Pricing rule deleted' });
  } catch (error) { next(error); }
});

router.get('/slabs', checkPermission('pricing', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const q = req.query as { productId?: string };
    const where: Record<string, unknown> = { status: 'ACTIVE' };
    if (q.productId) where.productId = q.productId;
    const slabs = await prisma.bulkPricingSlab.findMany({ where: where as never, include: { product: true }, orderBy: { minQty: 'asc' } });
    res.json({ success: true, data: slabs, message: 'Slabs retrieved' });
  } catch (error) { next(error); }
});

router.post('/slabs', checkPermission('pricing', 'create'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = slabSchema.parse(req.body);
    const slab = await prisma.bulkPricingSlab.create({ data: { ...data, zoneId: data.zoneId ?? null, maxQty: data.maxQty ?? null, createdBy: req.user!.userId } });
    res.status(201).json({ success: true, data: slab, message: 'Slab created' });
  } catch (error) { next(error); }
});

router.get('/audit-log', checkPermission('pricing', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const q = req.query as { productId?: string; from?: string; to?: string };
    const where: Record<string, unknown> = {};
    if (q.productId) where.pricingRule = { productId: q.productId };
    if (q.from || q.to) {
      where.changedAt = {};
      if (q.from) (where.changedAt as Record<string, unknown>).gte = new Date(q.from);
      if (q.to) (where.changedAt as Record<string, unknown>).lte = new Date(q.to);
    }
    const logs = await prisma.pricingAuditLog.findMany({ where: where as never, include: { pricingRule: { include: { product: true } }, changedByUser: true }, orderBy: { changedAt: 'desc' }, take: 100 });
    res.json({ success: true, data: logs, message: 'Audit log retrieved' });
  } catch (error) { next(error); }
});

router.post('/compute', checkPermission('pricing', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { productId, role, quantity, zoneId } = computeSchema.parse(req.body);
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) { res.status(404).json({ success: false, data: null, message: 'Product not found' }); return; }

    const rule = await prisma.pricingRule.findFirst({
      where: { productId, customerGroup: role, isActive: true, status: 'ACTIVE', validFrom: { lte: new Date() }, OR: [{ validTo: null }, { validTo: { gte: new Date() } }] },
      orderBy: [{ zoneId: 'desc' }, { createdAt: 'desc' }],
    });

    let unitPrice = Number(product.basePrice);
    if (rule) {
      unitPrice = rule.priceType === 'FIXED' ? Number(rule.priceValue) : Number(product.basePrice) * (1 + Number(rule.priceValue) / 100);
    }

    const slab = await prisma.bulkPricingSlab.findFirst({
      where: { productId, customerGroup: role, status: 'ACTIVE', minQty: { lte: quantity }, OR: [{ maxQty: null }, { maxQty: { gte: quantity } }] },
    });
    if (slab) unitPrice = Number(slab.slabPrice);

    const lineTotal = unitPrice * quantity;
    res.json({ success: true, data: { unitPrice, quantity, lineTotal, appliedRule: rule?.id, appliedSlab: slab?.id }, message: 'Price computed' });
  } catch (error) { next(error); }
});

export default router;

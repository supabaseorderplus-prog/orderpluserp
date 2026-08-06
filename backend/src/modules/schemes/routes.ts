import { Router } from 'express';
import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/db';
import { authenticate } from '../../middleware/auth';
import { checkPermission } from '../../middleware/rbac';
import { AuthRequest, PaginationQuery } from '../../types';

const router = Router();
router.use(authenticate);

const schemeSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  schemeType: z.enum(['TARGET_REWARD', 'VOLUME_SLAB', 'COMBO', 'TIME_CAMPAIGN']),
  applicableRole: z.enum(['SUPER_ADMIN', 'ADMIN', 'SALES_MANAGER', 'FIELD_MANAGER', 'SALESMAN', 'DISTRIBUTOR', 'SUB_DISTRIBUTOR', 'RETAILER', 'WAREHOUSE_MANAGER', 'ACCOUNTANT']),
  zoneId: z.string().uuid().nullable().optional(),
  validFrom: z.string().transform((s) => new Date(s)),
  validTo: z.string().transform((s) => new Date(s)),
  rewardType: z.enum(['CASH', 'PRODUCT', 'CREDIT_NOTE', 'GIFT']),
  rewardValue: z.number().positive(),
  conditions: z.record(z.unknown()).optional(),
});

router.get('/', checkPermission('schemes', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const q = req.query as PaginationQuery;
    const page = parseInt(q.page || '1', 10);
    const limit = parseInt(q.limit || '20', 10);
    const [schemes, total] = await Promise.all([
      prisma.scheme.findMany({ where: { status: 'ACTIVE' }, include: { zone: true }, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' } }),
      prisma.scheme.count({ where: { status: 'ACTIVE' } }),
    ]);
    res.json({ success: true, data: schemes, message: 'Schemes retrieved', meta: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) { next(error); }
});

router.post('/', checkPermission('schemes', 'create'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = schemeSchema.parse(req.body);
    const scheme = await prisma.scheme.create({ data: { ...data, zoneId: data.zoneId ?? null, conditions: data.conditions as any, createdBy: req.user!.userId } });
    res.status(201).json({ success: true, data: scheme, message: 'Scheme created' });
  } catch (error) { next(error); }
});

router.put('/:id', checkPermission('schemes', 'edit'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const data = schemeSchema.partial().parse(req.body);
    const scheme = await prisma.scheme.update({ where: { id }, data: data as never });
    res.json({ success: true, data: scheme, message: 'Scheme updated' });
  } catch (error) { next(error); }
});

router.delete('/:id', checkPermission('schemes', 'delete'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    await prisma.scheme.update({ where: { id }, data: { status: 'DELETED' } });
    res.json({ success: true, data: null, message: 'Scheme deleted' });
  } catch (error) { next(error); }
});

router.get('/active', checkPermission('schemes', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const now = new Date();
    const schemes = await prisma.scheme.findMany({
      where: { isActive: true, status: 'ACTIVE', validFrom: { lte: now }, validTo: { gte: now }, OR: [{ applicableRole: req.user!.roleName }, { zoneId: null }] },
    });
    res.json({ success: true, data: schemes, message: 'Active schemes retrieved' });
  } catch (error) { next(error); }
});

router.get('/:id/progress/:userId', checkPermission('schemes', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const schemeId = req.params.id as string;
    const userId = req.params.userId as string;
    const progress = await prisma.schemeProgress.findUnique({ where: { schemeId_userId: { schemeId, userId } } });
    res.json({ success: true, data: progress, message: 'Progress retrieved' });
  } catch (error) { next(error); }
});

export default router;

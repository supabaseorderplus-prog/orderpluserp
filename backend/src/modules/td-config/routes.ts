import { Router } from 'express';
import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/db';
import { authenticate } from '../../middleware/auth';
import { checkPermission } from '../../middleware/rbac';
import { AuthRequest } from '../../types';

const router = Router();
router.use(authenticate);

const tdConfigSchema = z.object({
  type: z.enum(['td', 'cd']),
  applicablePartyType: z.enum(['CNF', 'SUPER_DEALER', 'RETAILER']),
  partyId: z.string().uuid().nullable().optional(),
  tdPercent: z.number().positive().optional(),
  slabName: z.enum(['ON_DELIVERY', 'WITHIN_7_DAYS', 'WITHIN_15_DAYS', 'WITHIN_30_DAYS']).optional(),
  cdPercent: z.number().positive().optional(),
  validFrom: z.string(),
  validTo: z.string().nullable().optional(),
  notes: z.string().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'DELETED']).optional(),
});

router.get('/', checkPermission('pricing', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const [tdConfigs, cdConfigs] = await Promise.all([
      prisma.tDConfig.findMany({
        where: { status: { not: 'DELETED' } },
        include: { party: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.cDConfig.findMany({
        where: { status: { not: 'DELETED' } },
        include: { party: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    res.json({ success: true, data: { td: tdConfigs, cd: cdConfigs }, message: 'TD/CD configs retrieved' });
  } catch (error) { next(error); }
});

router.post('/', checkPermission('pricing', 'create'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = tdConfigSchema.parse(req.body);
    const { type, ...rest } = data;

    if (type === 'td') {
      const tdConfig = await prisma.tDConfig.create({
        data: {
          applicablePartyType: rest.applicablePartyType,
          partyId: rest.partyId || null,
          tdPercent: rest.tdPercent || 0,
          validFrom: new Date(rest.validFrom),
          validTo: rest.validTo ? new Date(rest.validTo) : null,
          notes: rest.notes || null,
          status: rest.status || 'ACTIVE',
          createdBy: req.user!.userId,
        },
        include: { party: true },
      });
      res.status(201).json({ success: true, data: tdConfig, message: 'TD config created' });
    } else if (type === 'cd') {
      const cdConfig = await prisma.cDConfig.create({
        data: {
          applicablePartyType: rest.applicablePartyType,
          partyId: rest.partyId || null,
          slabName: rest.slabName || 'ON_DELIVERY',
          cdPercent: rest.cdPercent || 0,
          validFrom: new Date(rest.validFrom),
          validTo: rest.validTo ? new Date(rest.validTo) : null,
          notes: rest.notes || null,
          status: rest.status || 'ACTIVE',
          createdBy: req.user!.userId,
        },
        include: { party: true },
      });
      res.status(201).json({ success: true, data: cdConfig, message: 'CD config created' });
    }
  } catch (error) { next(error); }
});

router.put('/', checkPermission('pricing', 'edit'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = tdConfigSchema.partial().extend({ id: z.string().uuid() }).parse(req.body);
    const { type, id, ...rest } = data;

    if (type === 'td') {
      const tdConfig = await prisma.tDConfig.update({
        where: { id },
        data: {
          applicablePartyType: rest.applicablePartyType,
          partyId: rest.partyId !== undefined ? rest.partyId : undefined,
          tdPercent: rest.tdPercent,
          validFrom: rest.validFrom ? new Date(rest.validFrom) : undefined,
          validTo: rest.validTo !== undefined ? (rest.validTo ? new Date(rest.validTo) : null) : undefined,
          notes: rest.notes,
          status: rest.status,
        },
        include: { party: true },
      });
      res.json({ success: true, data: tdConfig, message: 'TD config updated' });
    } else if (type === 'cd') {
      const cdConfig = await prisma.cDConfig.update({
        where: { id },
        data: {
          applicablePartyType: rest.applicablePartyType,
          partyId: rest.partyId !== undefined ? rest.partyId : undefined,
          slabName: rest.slabName,
          cdPercent: rest.cdPercent,
          validFrom: rest.validFrom ? new Date(rest.validFrom) : undefined,
          validTo: rest.validTo !== undefined ? (rest.validTo ? new Date(rest.validTo) : null) : undefined,
          notes: rest.notes,
          status: rest.status,
        },
        include: { party: true },
      });
      res.json({ success: true, data: cdConfig, message: 'CD config updated' });
    }
  } catch (error) { next(error); }
});

router.delete('/', checkPermission('pricing', 'delete'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { id, type } = req.query as { id: string; type: 'td' | 'cd' };

    if (type === 'td') {
      await prisma.tDConfig.update({ where: { id }, data: { status: 'DELETED' } });
    } else if (type === 'cd') {
      await prisma.cDConfig.update({ where: { id }, data: { status: 'DELETED' } });
    }

    res.json({ success: true, data: null, message: 'Config deleted' });
  } catch (error) { next(error); }
});

export default router;

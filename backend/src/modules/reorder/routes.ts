import { Router } from 'express';
import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/db';
import { authenticate } from '../../middleware/auth';
import { checkPermission } from '../../middleware/rbac';
import { AuthRequest } from '../../types';

const router = Router();
router.use(authenticate);

router.get('/settings/:retailerId', checkPermission('orders', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const retailerId = req.params.retailerId as string;
    const settings = await prisma.reorderSetting.findMany({
      where: { retailerId, status: 'ACTIVE' },
      include: { product: { select: { id: true, name: true, sku: true } } },
    });
    res.json({ success: true, data: settings, message: 'Reorder settings retrieved' });
  } catch (error) { next(error); }
});

router.put('/settings/:retailerId', checkPermission('orders', 'edit'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const retailerId = req.params.retailerId as string;
    const { settings } = z.object({
      settings: z.array(z.object({
        productId: z.string().uuid(),
        minThreshold: z.number().int().positive(),
        preferredQuantity: z.number().int().positive(),
        autoReorderEnabled: z.boolean(),
      })),
    }).parse(req.body);

    const results = await Promise.all(settings.map((s) =>
      prisma.reorderSetting.upsert({
        where: { retailerId_productId: { retailerId, productId: s.productId } },
        create: { retailerId, ...s },
        update: s,
      })
    ));

    res.json({ success: true, data: results, message: 'Reorder settings updated' });
  } catch (error) { next(error); }
});

router.post('/toggle', checkPermission('orders', 'edit'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { retailerId, enabled } = z.object({ retailerId: z.string().uuid(), enabled: z.boolean() }).parse(req.body);
    await prisma.reorderSetting.updateMany({ where: { retailerId }, data: { autoReorderEnabled: enabled } });
    res.json({ success: true, data: null, message: `Auto reorder ${enabled ? 'enabled' : 'disabled'}` });
  } catch (error) { next(error); }
});

router.get('/triggers', checkPermission('orders', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const triggers = await prisma.reorderTrigger.findMany({
      where: { status: { in: ['PENDING', 'NOTIFIED'] } },
      include: { retailer: { select: { id: true, name: true, phone: true } }, product: { select: { id: true, name: true, sku: true } } },
      orderBy: { triggeredAt: 'desc' },
    });
    res.json({ success: true, data: triggers, message: 'Reorder triggers retrieved' });
  } catch (error) { next(error); }
});

export default router;

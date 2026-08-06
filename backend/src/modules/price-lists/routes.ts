import { Router } from 'express';
import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/db';
import { authenticate } from '../../middleware/auth';
import { checkPermission } from '../../middleware/rbac';
import { AuthRequest } from '../../types';

const router = Router();
router.use(authenticate);

const priceListItemSchema = z.object({
  productId: z.string().uuid(),
  unitPrice: z.number().positive(),
  minMarginFloor: z.number().optional(),
  maxMarginCeiling: z.number().optional(),
});

const priceListSchema = z.object({
  name: z.string().min(1).max(200),
  code: z.string().min(1).max(50),
  applicablePartyType: z.enum(['CNF', 'SUPER_DEALER', 'RETAILER']),
  partyId: z.string().uuid().nullable().optional(),
  validFrom: z.string(),
  validTo: z.string().nullable().optional(),
  isCurrent: z.boolean().optional(),
  notes: z.string().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'DELETED']).optional(),
  items: z.array(priceListItemSchema),
});

router.get('/', checkPermission('pricing', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const priceLists = await prisma.priceList.findMany({
      where: { status: { not: 'DELETED' } },
      include: {
        party: true,
        items: {
          include: { product: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ success: true, data: priceLists, message: 'Price lists retrieved' });
  } catch (error) { next(error); }
});

router.post('/', checkPermission('pricing', 'create'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { items, ...data } = priceListSchema.parse(req.body);
    
    const priceList = await prisma.priceList.create({
      data: {
        name: data.name,
        code: data.code,
        applicablePartyType: data.applicablePartyType,
        partyId: data.partyId || null,
        validFrom: new Date(data.validFrom),
        validTo: data.validTo ? new Date(data.validTo) : null,
        isCurrent: data.isCurrent ?? true,
        notes: data.notes || null,
        status: data.status || 'ACTIVE',
        createdBy: req.user!.userId,
        items: {
          create: items.map(item => ({
            productId: item.productId,
            unitPrice: item.unitPrice,
            minMarginFloor: item.minMarginFloor || null,
            maxMarginCeiling: item.maxMarginCeiling || null,
          })),
        },
      },
      include: {
        party: true,
        items: {
          include: { product: true },
        },
      },
    });

    res.status(201).json({ success: true, data: priceList, message: 'Price list created' });
  } catch (error) { next(error); }
});

router.get('/:id', checkPermission('pricing', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const priceList = await prisma.priceList.findUnique({
      where: { id },
      include: {
        party: true,
        items: {
          include: { product: true },
        },
      },
    });
    if (!priceList || priceList.status === 'DELETED') {
      res.status(404).json({ success: false, data: null, message: 'Price list not found' });
      return;
    }
    res.json({ success: true, data: priceList, message: 'Price list retrieved' });
  } catch (error) { next(error); }
});

router.put('/:id', checkPermission('pricing', 'edit'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const { items, ...data } = priceListSchema.partial().extend({ items: z.array(priceListItemSchema).optional() }).parse(req.body);
    
    // Delete existing items
    await prisma.priceListItem.deleteMany({
      where: { priceListId: id },
    });

    const priceList = await prisma.priceList.update({
      where: { id },
      data: {
        name: data.name,
        code: data.code,
        applicablePartyType: data.applicablePartyType,
        partyId: data.partyId !== undefined ? data.partyId : undefined,
        validFrom: data.validFrom ? new Date(data.validFrom) : undefined,
        validTo: data.validTo !== undefined ? (data.validTo ? new Date(data.validTo) : null) : undefined,
        isCurrent: data.isCurrent,
        notes: data.notes,
        status: data.status,
        items: items ? {
          create: items.map(item => ({
            productId: item.productId,
            unitPrice: item.unitPrice,
            minMarginFloor: item.minMarginFloor || null,
            maxMarginCeiling: item.maxMarginCeiling || null,
          })),
        } : undefined,
      },
      include: {
        party: true,
        items: {
          include: { product: true },
        },
      },
    });

    res.json({ success: true, data: priceList, message: 'Price list updated' });
  } catch (error) { next(error); }
});

router.delete('/:id', checkPermission('pricing', 'delete'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    await prisma.priceList.update({ where: { id }, data: { status: 'DELETED' } });
    res.json({ success: true, data: null, message: 'Price list deleted' });
  } catch (error) { next(error); }
});

export default router;

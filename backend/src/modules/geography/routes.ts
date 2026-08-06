import { Router } from 'express';
import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/db';
import { authenticate } from '../../middleware/auth';
import { checkPermission } from '../../middleware/rbac';
import { AuthRequest } from '../../types';

const router = Router();
router.use(authenticate);

// ── States ──
router.get('/states', checkPermission('geography', 'view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const states = await prisma.state.findMany({ where: { status: 'ACTIVE' }, orderBy: { name: 'asc' } });
    res.json({ success: true, data: states, message: 'States retrieved' });
  } catch (e) { next(e); }
});

router.post('/states', checkPermission('geography', 'create'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = z.object({ name: z.string(), code: z.string().length(2) }).parse(req.body);
    const state = await prisma.state.create({ data: { ...data, createdBy: req.user!.userId } });
    res.status(201).json({ success: true, data: state, message: 'State created' });
  } catch (e) { next(e); }
});

// ── Districts ──
router.get('/districts', checkPermission('geography', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const q = req.query as { stateId?: string };
    const where: Record<string, unknown> = { status: 'ACTIVE' };
    if (q.stateId) where.stateId = q.stateId;
    const districts = await prisma.district.findMany({ where: where as never, include: { state: true }, orderBy: { name: 'asc' } });
    res.json({ success: true, data: districts, message: 'Districts retrieved' });
  } catch (e) { next(e); }
});

router.post('/districts', checkPermission('geography', 'create'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = z.object({ name: z.string(), stateId: z.string().uuid() }).parse(req.body);
    const district = await prisma.district.create({ data: { ...data, createdBy: req.user!.userId } });
    res.status(201).json({ success: true, data: district, message: 'District created' });
  } catch (e) { next(e); }
});

// ── Zones ──
router.get('/zones', checkPermission('geography', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const q = req.query as { districtId?: string; stateId?: string };
    const where: Record<string, unknown> = { status: 'ACTIVE' };
    if (q.districtId) where.districtId = q.districtId;
    if (q.stateId) where.stateId = q.stateId;
    const zones = await prisma.zone.findMany({ where: where as never, include: { district: { include: { state: true } } }, orderBy: { name: 'asc' } });
    res.json({ success: true, data: zones, message: 'Zones retrieved' });
  } catch (e) { next(e); }
});

router.post('/zones', checkPermission('geography', 'create'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = z.object({ name: z.string(), stateId: z.string().uuid(), districtId: z.string().uuid() }).parse(req.body);
    const zone = await prisma.zone.create({ data: { ...data, createdBy: req.user!.userId } });
    res.status(201).json({ success: true, data: zone, message: 'Zone created' });
  } catch (e) { next(e); }
});

router.put('/zones/:id', checkPermission('geography', 'edit'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const data = z.object({ name: z.string().optional(), isActive: z.boolean().optional() }).parse(req.body);
    const zone = await prisma.zone.update({ where: { id }, data });
    res.json({ success: true, data: zone, message: 'Zone updated' });
  } catch (e) { next(e); }
});

router.post('/zones/:id/assign-user', checkPermission('geography', 'edit'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body);
    const assignment = await prisma.userZoneAssignment.upsert({
      where: { userId_zoneId: { userId, zoneId: id } },
      create: { userId, zoneId: id, assignedBy: req.user!.userId },
      update: { assignedBy: req.user!.userId, status: 'ACTIVE' },
    });
    await prisma.user.update({ where: { id: userId }, data: { zoneId: id } });
    res.json({ success: true, data: assignment, message: 'User assigned to zone' });
  } catch (e) { next(e); }
});

export default router;

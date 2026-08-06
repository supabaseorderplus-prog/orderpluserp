import { Router } from 'express';
import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../../config/db';
import { authenticate } from '../../middleware/auth';
import { checkPermission, filterByOwnership } from '../../middleware/rbac';
import { AuthRequest, PaginationQuery } from '../../types';
import { RoleName } from '@prisma/client';

const router = Router();
router.use(authenticate);

// Dedicated endpoint for fetching salesmen (used by parties page dropdown)
// Does NOT require users.view permission - just needs authentication
router.get('/salesmen', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const search = req.query.search as string | undefined;
    const limit = parseInt(req.query.limit as string || '100', 10);

    const where: Record<string, unknown> = {
      status: { not: 'DELETED' },
      role: { name: RoleName.SALESMAN },
    };

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    const salesmen = await prisma.user.findMany({
      where: where as never,
      select: { id: true, name: true, email: true },
      take: limit,
      orderBy: { name: 'asc' },
    });

    res.json({ success: true, data: salesmen, message: 'Salesmen retrieved' });
  } catch (error) { next(error); }
});

const partySchema = z.object({
  name: z.string().min(1).max(200),
  party_code: z.string().min(1).max(50),
  party_type_id: z.string().uuid(),
  salesman_id: z.string().uuid().nullable().optional(),
  address_line1: z.string().optional(),
  city: z.string().optional(),
  pin_code: z.string().optional(),
  phone: z.string().optional(),
  contact_phone: z.string().optional(),
  email: z.string().email().or(z.literal('')).optional(),
  contact_email: z.string().email().or(z.literal('')).optional(),
  gstin: z.string().optional(),
  pan: z.string().optional(),
  trade_name: z.string().optional(),
  contact_person: z.string().optional(),
  credit_limit: z.number().optional(),
  opening_balance: z.number().optional(),
  wallet_balance: z.number().optional(),
  payment_terms_days: z.number().optional(),
  portal_phone: z.string().nullable().optional(),
  portal_password: z.string().nullable().optional(),
  parent_party_id: z.string().uuid().nullable().optional(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  provision_auth_user: z.boolean().optional(),
});

router.get('/', checkPermission('users', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const q = req.query as PaginationQuery & { partyTypeId?: string; search?: string };
    const page = parseInt(q.page || '1', 10);
    const limit = parseInt(q.limit || '20', 10);

    const where: Record<string, unknown> = { status: { not: 'DELETED' } };
    if (q.partyTypeId) where.partyTypeId = q.partyTypeId;
    if (q.search) {
      where.OR = [
        { name: { contains: q.search, mode: 'insensitive' } },
        { partyCode: { contains: q.search, mode: 'insensitive' } },
      ];
    }

    // Filter parties based on user role and ownership
    const ownership = filterByOwnership(req);
    if (ownership.userId && req.user?.roleName === RoleName.SALESMAN) {
      // Salesman can only see their assigned parties
      where.salesmanId = ownership.userId;
    } else if (ownership.zoneId) {
      // Sales/Field managers can see parties in their zone
      // Note: This requires parties to have zoneId field in future
      // For now, they see all parties
    }

    const [parties, total] = await Promise.all([
      prisma.party.findMany({
        where: where as never,
        include: { partyType: true },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.party.count({ where: where as never }),
    ]);

    res.json({
      success: true,
      data: parties,
      message: 'Parties retrieved',
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) { next(error); }
});

router.post('/', checkPermission('users', 'create'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const data = partySchema.parse(req.body);
    const party = await prisma.party.create({
      data: {
        name: data.name,
        partyCode: data.party_code,
        partyTypeId: data.party_type_id,
        salesmanId: data.salesman_id || (req.user?.roleName === RoleName.SALESMAN ? req.user.userId : undefined),
        address: data.address_line1 || data.contact_person || undefined,
        phone: data.contact_phone || data.phone || undefined,
        email: data.contact_email || data.email || undefined,
        gstin: data.gstin || undefined,
        openingBalance: data.opening_balance ?? 0,
        walletBalance: data.wallet_balance ?? 0,
        createdBy: req.user!.userId,
      },
      include: { partyType: true },
    });

    res.status(201).json({ success: true, data: party, message: 'Party created' });
  } catch (error) { next(error); }
});

router.get('/:id', checkPermission('users', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const partyId = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
    const party = await prisma.party.findUnique({
      where: { id: partyId },
      include: { partyType: true },
    });
    if (!party || party.status === 'DELETED') {
      res.status(404).json({ success: false, data: null, message: 'Party not found' });
      return;
    }
    res.json({ success: true, data: party, message: 'Party retrieved' });
  } catch (error) { next(error); }
});

router.put('/:id', checkPermission('users', 'edit'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const partyId = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
    const data = partySchema.partial().parse(req.body);
    const updateData: Record<string, unknown> = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.party_code !== undefined) updateData.partyCode = data.party_code;
    if (data.party_type_id !== undefined) updateData.partyTypeId = data.party_type_id;
    if (data.salesman_id !== undefined) updateData.salesmanId = data.salesman_id;
    if (data.address_line1 !== undefined) updateData.address = data.address_line1;
    if (data.contact_phone !== undefined) updateData.phone = data.contact_phone;
    if (data.phone !== undefined && updateData.phone === undefined) updateData.phone = data.phone;
    if (data.contact_email !== undefined) updateData.email = data.contact_email;
    if (data.email !== undefined && updateData.email === undefined) updateData.email = data.email;
    if (data.gstin !== undefined) updateData.gstin = data.gstin;
    if (data.opening_balance !== undefined) updateData.openingBalance = data.opening_balance;
    if (data.wallet_balance !== undefined) updateData.walletBalance = data.wallet_balance;
    const party = await prisma.party.update({
      where: { id: partyId },
      data: updateData as never,
      include: { partyType: true },
    });
    res.json({ success: true, data: party, message: 'Party updated' });
  } catch (error) { next(error); }
});

router.delete('/:id', checkPermission('users', 'delete'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const partyId = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
    await prisma.party.update({ where: { id: partyId }, data: { status: 'DELETED' } });
    res.json({ success: true, data: null, message: 'Party deleted' });
  } catch (error) { next(error); }
});

// Get visit logs for a party
router.get('/:id/visit-logs', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const partyId = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];

    const party = await prisma.party.findUnique({ where: { id: partyId } });
    if (!party || party.status === 'DELETED') {
      res.status(404).json({ success: false, message: 'Party not found' });
      return;
    }

    const logs = await prisma.partyVisitLog.findMany({
      where: { partyId },
      include: { visitor: { select: { name: true } } },
      orderBy: { visitDate: 'desc' },
    });

    const result = logs.map((log) => ({
      id: log.id,
      visited_by: log.visitedBy,
      visitor_name: log.visitor?.name || 'Unknown',
      visit_date: log.visitDate.toISOString(),
      notes: log.notes,
      created_at: log.createdAt.toISOString(),
    }));

    res.json({ success: true, data: result, total: result.length });
  } catch (error) { next(error); }
});

// Create a visit log for a party
router.post('/:id/visit-logs', authenticate, async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const partyId = typeof req.params.id === 'string' ? req.params.id : req.params.id[0];
    const { notes, visit_date } = req.body;

    const party = await prisma.party.findUnique({ where: { id: partyId } });
    if (!party || party.status === 'DELETED') {
      res.status(404).json({ success: false, message: 'Party not found' });
      return;
    }

    const log = await prisma.partyVisitLog.create({
      data: {
        partyId,
        visitedBy: req.user!.userId,
        notes: notes || null,
        visitDate: visit_date ? new Date(visit_date) : new Date(),
      },
    });

    res.status(201).json({ success: true, data: log });
  } catch (error) { next(error); }
});

export default router;

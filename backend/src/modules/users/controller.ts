import { Response, NextFunction } from 'express';
import { z } from 'zod';
import * as userService from './service';
import { AuthRequest, PaginationQuery } from '../../types';
import { prisma } from '../../config/db';

const createUserSchema = z.object({
  name: z.string().min(2).max(100),
  email: z.string().email(),
  phone: z.string().regex(/^[6-9]\d{9}$/, 'Invalid Indian phone number'),
  password: z.string().min(8),
  roleId: z.string().uuid(),
  zoneId: z.string().uuid().optional(),
  parentUserId: z.string().uuid().optional(),
  warehouseId: z.string().uuid().optional(),
});

const updateUserSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  email: z.string().email().optional(),
  phone: z.string().regex(/^[6-9]\d{9}$/).optional(),
  password: z.string().min(8).optional(),
  roleId: z.string().uuid().optional(),
  zoneId: z.string().uuid().optional(),
  parentUserId: z.string().uuid().optional(),
  warehouseId: z.string().uuid().optional(),
});

export async function listUsers(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = req.query as PaginationQuery & { roleId?: string; role?: string; zoneId?: string; status?: string };

    const result = await userService.listUsers({
      page: parseInt(query.page || '1', 10),
      limit: parseInt(query.limit || '20', 10),
      sort: query.sort || 'createdAt',
      order: query.order || 'desc',
      search: query.search,
      roleId: query.roleId,
      role: query.role,
      zoneId: query.zoneId,
      status: query.status,
    });

    res.json({
      success: true,
      data: result.users,
      message: 'Users retrieved',
      meta: result.meta,
    });
  } catch (error) {
    next(error);
  }
}

export async function createUser(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = createUserSchema.parse(req.body);
    const user = await userService.createUser({
      ...data,
      createdBy: req.user!.userId,
    });

    await prisma.auditLog.create({
      data: {
        userId: req.user!.userId,
        action: 'CREATE',
        module: 'users',
        recordId: user.id,
        newData: { name: user.name, email: user.email, role: user.role.name },
        ipAddress: req.ip || null,
        userAgent: req.headers['user-agent'] || null,
      },
    });

    res.status(201).json({
      success: true,
      data: user,
      message: 'User created',
    });
  } catch (error) {
    next(error);
  }
}

export async function getUser(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string;
    const user = await userService.getUserById(id);
    res.json({ success: true, data: user, message: 'User retrieved' });
  } catch (error) {
    next(error);
  }
}

export async function updateUser(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string;
    const data = updateUserSchema.parse(req.body);
    const oldUser = await userService.getUserById(id);
    const user = await userService.updateUser(id, data);

    await prisma.auditLog.create({
      data: {
        userId: req.user!.userId,
        action: 'UPDATE',
        module: 'users',
        recordId: user.id,
        oldData: { name: oldUser.name, email: oldUser.email },
        newData: { name: user.name, email: user.email },
        ipAddress: req.ip || null,
        userAgent: req.headers['user-agent'] || null,
      },
    });

    res.json({ success: true, data: user, message: 'User updated' });
  } catch (error) {
    next(error);
  }
}

export async function deleteUser(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string;
    await userService.deleteUser(id);

    await prisma.auditLog.create({
      data: {
        userId: req.user!.userId,
        action: 'DELETE',
        module: 'users',
        recordId: id,
        ipAddress: req.ip || null,
        userAgent: req.headers['user-agent'] || null,
      },
    });

    res.json({ success: true, data: null, message: 'User deleted' });
  } catch (error) {
    next(error);
  }
}

export async function getUserHierarchy(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string;
    const tree = await userService.getUserHierarchy(id);
    res.json({ success: true, data: tree, message: 'Hierarchy retrieved' });
  } catch (error) {
    next(error);
  }
}

export async function getUserPerformance(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const id = req.params.id as string;
    const perf = await userService.getUserPerformance(id);
    res.json({ success: true, data: perf, message: 'Performance retrieved' });
  } catch (error) {
    next(error);
  }
}

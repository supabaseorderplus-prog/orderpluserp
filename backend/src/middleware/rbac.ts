import { Response, NextFunction } from 'express';
import { AuthRequest, PermissionCache } from '../types';
import redis from '../config/redis';
import { prisma } from '../config/db';
import { RoleName } from '@prisma/client';

type Action = 'view' | 'create' | 'edit' | 'delete' | 'approve';

async function getUserPermissions(roleId: string): Promise<PermissionCache> {
  const cacheKey = `permissions:${roleId}`;
  
  // Try to get from cache
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached) as PermissionCache;
    }
  } catch (error) {
    console.log('Redis unavailable for permission cache, fetching from database');
  }

  const permissions = await prisma.permission.findMany({
    where: { roleId, status: 'ACTIVE' },
  });

  const permMap: PermissionCache = {};
  for (const p of permissions) {
    permMap[p.moduleName] = {
      canView: p.canView,
      canCreate: p.canCreate,
      canEdit: p.canEdit,
      canDelete: p.canDelete,
      canApprove: p.canApprove,
    };
  }

  // Try to cache, but don't fail if Redis is unavailable
  try {
    await redis.set(cacheKey, JSON.stringify(permMap), 'EX', 3600);
  } catch (error) {
    console.log('Redis unavailable, skipping permission cache storage');
  }
  
  return permMap;
}

export function checkPermission(moduleName: string, action: Action) {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ success: false, data: null, message: 'Not authenticated' });
      return;
    }

    if (req.user.roleName === RoleName.SUPER_ADMIN) {
      next();
      return;
    }

    const permissions = await getUserPermissions(req.user.roleId);
    const modulePerm = permissions[moduleName];

    if (!modulePerm) {
      res.status(403).json({ success: false, data: null, message: 'Access denied: no permissions for this module' });
      return;
    }

    const actionMap: Record<Action, boolean> = {
      view: modulePerm.canView,
      create: modulePerm.canCreate,
      edit: modulePerm.canEdit,
      delete: modulePerm.canDelete,
      approve: modulePerm.canApprove,
    };

    if (!actionMap[action]) {
      res.status(403).json({ success: false, data: null, message: `Access denied: cannot ${action} in ${moduleName}` });
      return;
    }

    next();
  };
}

export function filterByOwnership(req: AuthRequest): { userId?: string; zoneId?: string; parentUserId?: string } {
  if (!req.user) return {};

  const role = req.user.roleName;
  const filters: { userId?: string; zoneId?: string; parentUserId?: string } = {};

  switch (role) {
    case RoleName.SUPER_ADMIN:
    case RoleName.ADMIN:
      break;
    case RoleName.SALES_MANAGER:
    case RoleName.FIELD_MANAGER:
      if (req.user.zoneId) filters.zoneId = req.user.zoneId;
      break;
    case RoleName.SALESMAN:
      filters.userId = req.user.userId;
      break;
    case RoleName.DISTRIBUTOR:
    case RoleName.SUB_DISTRIBUTOR:
      filters.parentUserId = req.user.userId;
      break;
    case RoleName.RETAILER:
      filters.userId = req.user.userId;
      break;
    case RoleName.WAREHOUSE_MANAGER:
      if (req.user.zoneId) filters.zoneId = req.user.zoneId;
      break;
    case RoleName.ACCOUNTANT:
      break;
  }

  return filters;
}

export async function invalidatePermissionCache(roleId: string): Promise<void> {
  try {
    await redis.del(`permissions:${roleId}`);
  } catch (error) {
    console.log('Redis unavailable, skipping permission cache invalidation');
  }
}

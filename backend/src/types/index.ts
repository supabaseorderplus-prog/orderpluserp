import { Request } from 'express';
import { RoleName } from '@prisma/client';

export interface JwtPayload {
  userId: string;
  email: string;
  roleId: string;
  roleName: RoleName;
  zoneId: string | null;
}

export interface AuthRequest extends Request {
  user?: JwtPayload;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data: T;
  message: string;
  meta?: PaginationMeta;
}

export interface PaginationQuery {
  page?: string;
  limit?: string;
  sort?: string;
  order?: 'asc' | 'desc';
  search?: string;
}

export interface PermissionCache {
  [moduleName: string]: {
    canView: boolean;
    canCreate: boolean;
    canEdit: boolean;
    canDelete: boolean;
    canApprove: boolean;
  };
}

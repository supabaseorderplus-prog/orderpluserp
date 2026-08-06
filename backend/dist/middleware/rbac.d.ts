import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
type Action = 'view' | 'create' | 'edit' | 'delete' | 'approve';
export declare function checkPermission(moduleName: string, action: Action): (req: AuthRequest, res: Response, next: NextFunction) => Promise<void>;
export declare function filterByOwnership(req: AuthRequest): {
    userId?: string;
    zoneId?: string;
    parentUserId?: string;
};
export declare function invalidatePermissionCache(roleId: string): Promise<void>;
export {};
//# sourceMappingURL=rbac.d.ts.map
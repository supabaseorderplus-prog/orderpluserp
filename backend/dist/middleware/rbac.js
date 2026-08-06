"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkPermission = checkPermission;
exports.filterByOwnership = filterByOwnership;
exports.invalidatePermissionCache = invalidatePermissionCache;
const redis_1 = __importDefault(require("../config/redis"));
const db_1 = require("../config/db");
const client_1 = require("@prisma/client");
async function getUserPermissions(roleId) {
    const cacheKey = `permissions:${roleId}`;
    // Try to get from cache
    try {
        const cached = await redis_1.default.get(cacheKey);
        if (cached) {
            return JSON.parse(cached);
        }
    }
    catch (error) {
        console.log('Redis unavailable for permission cache, fetching from database');
    }
    const permissions = await db_1.prisma.permission.findMany({
        where: { roleId, status: 'ACTIVE' },
    });
    const permMap = {};
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
        await redis_1.default.set(cacheKey, JSON.stringify(permMap), 'EX', 3600);
    }
    catch (error) {
        console.log('Redis unavailable, skipping permission cache storage');
    }
    return permMap;
}
function checkPermission(moduleName, action) {
    return async (req, res, next) => {
        if (!req.user) {
            res.status(401).json({ success: false, data: null, message: 'Not authenticated' });
            return;
        }
        if (req.user.roleName === client_1.RoleName.SUPER_ADMIN) {
            next();
            return;
        }
        const permissions = await getUserPermissions(req.user.roleId);
        const modulePerm = permissions[moduleName];
        if (!modulePerm) {
            res.status(403).json({ success: false, data: null, message: 'Access denied: no permissions for this module' });
            return;
        }
        const actionMap = {
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
function filterByOwnership(req) {
    if (!req.user)
        return {};
    const role = req.user.roleName;
    const filters = {};
    switch (role) {
        case client_1.RoleName.SUPER_ADMIN:
        case client_1.RoleName.ADMIN:
            break;
        case client_1.RoleName.SALES_MANAGER:
        case client_1.RoleName.FIELD_MANAGER:
            if (req.user.zoneId)
                filters.zoneId = req.user.zoneId;
            break;
        case client_1.RoleName.SALESMAN:
            filters.userId = req.user.userId;
            break;
        case client_1.RoleName.DISTRIBUTOR:
        case client_1.RoleName.SUB_DISTRIBUTOR:
            filters.parentUserId = req.user.userId;
            break;
        case client_1.RoleName.RETAILER:
            filters.userId = req.user.userId;
            break;
        case client_1.RoleName.WAREHOUSE_MANAGER:
            if (req.user.zoneId)
                filters.zoneId = req.user.zoneId;
            break;
        case client_1.RoleName.ACCOUNTANT:
            break;
    }
    return filters;
}
async function invalidatePermissionCache(roleId) {
    try {
        await redis_1.default.del(`permissions:${roleId}`);
    }
    catch (error) {
        console.log('Redis unavailable, skipping permission cache invalidation');
    }
}
//# sourceMappingURL=rbac.js.map
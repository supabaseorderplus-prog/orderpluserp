"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.listUsers = listUsers;
exports.createUser = createUser;
exports.getUser = getUser;
exports.updateUser = updateUser;
exports.deleteUser = deleteUser;
exports.getUserHierarchy = getUserHierarchy;
exports.getUserPerformance = getUserPerformance;
const zod_1 = require("zod");
const userService = __importStar(require("./service"));
const db_1 = require("../../config/db");
const createUserSchema = zod_1.z.object({
    name: zod_1.z.string().min(2).max(100),
    email: zod_1.z.string().email(),
    phone: zod_1.z.string().regex(/^[6-9]\d{9}$/, 'Invalid Indian phone number'),
    password: zod_1.z.string().min(8),
    roleId: zod_1.z.string().uuid(),
    zoneId: zod_1.z.string().uuid().optional(),
    parentUserId: zod_1.z.string().uuid().optional(),
    warehouseId: zod_1.z.string().uuid().optional(),
});
const updateUserSchema = zod_1.z.object({
    name: zod_1.z.string().min(2).max(100).optional(),
    email: zod_1.z.string().email().optional(),
    phone: zod_1.z.string().regex(/^[6-9]\d{9}$/).optional(),
    password: zod_1.z.string().min(8).optional(),
    roleId: zod_1.z.string().uuid().optional(),
    zoneId: zod_1.z.string().uuid().optional(),
    parentUserId: zod_1.z.string().uuid().optional(),
    warehouseId: zod_1.z.string().uuid().optional(),
});
async function listUsers(req, res, next) {
    try {
        const query = req.query;
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
    }
    catch (error) {
        next(error);
    }
}
async function createUser(req, res, next) {
    try {
        const data = createUserSchema.parse(req.body);
        const user = await userService.createUser({
            ...data,
            createdBy: req.user.userId,
        });
        await db_1.prisma.auditLog.create({
            data: {
                userId: req.user.userId,
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
    }
    catch (error) {
        next(error);
    }
}
async function getUser(req, res, next) {
    try {
        const id = req.params.id;
        const user = await userService.getUserById(id);
        res.json({ success: true, data: user, message: 'User retrieved' });
    }
    catch (error) {
        next(error);
    }
}
async function updateUser(req, res, next) {
    try {
        const id = req.params.id;
        const data = updateUserSchema.parse(req.body);
        const oldUser = await userService.getUserById(id);
        const user = await userService.updateUser(id, data);
        await db_1.prisma.auditLog.create({
            data: {
                userId: req.user.userId,
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
    }
    catch (error) {
        next(error);
    }
}
async function deleteUser(req, res, next) {
    try {
        const id = req.params.id;
        await userService.deleteUser(id);
        await db_1.prisma.auditLog.create({
            data: {
                userId: req.user.userId,
                action: 'DELETE',
                module: 'users',
                recordId: id,
                ipAddress: req.ip || null,
                userAgent: req.headers['user-agent'] || null,
            },
        });
        res.json({ success: true, data: null, message: 'User deleted' });
    }
    catch (error) {
        next(error);
    }
}
async function getUserHierarchy(req, res, next) {
    try {
        const id = req.params.id;
        const tree = await userService.getUserHierarchy(id);
        res.json({ success: true, data: tree, message: 'Hierarchy retrieved' });
    }
    catch (error) {
        next(error);
    }
}
async function getUserPerformance(req, res, next) {
    try {
        const id = req.params.id;
        const perf = await userService.getUserPerformance(id);
        res.json({ success: true, data: perf, message: 'Performance retrieved' });
    }
    catch (error) {
        next(error);
    }
}
//# sourceMappingURL=controller.js.map
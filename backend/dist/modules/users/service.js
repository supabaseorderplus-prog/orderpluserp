"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createUser = createUser;
exports.listUsers = listUsers;
exports.getUserById = getUserById;
exports.updateUser = updateUser;
exports.deleteUser = deleteUser;
exports.getUserHierarchy = getUserHierarchy;
exports.getUserPerformance = getUserPerformance;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const db_1 = require("../../config/db");
const errorHandler_1 = require("../../middleware/errorHandler");
async function createUser(input) {
    const existingEmail = await db_1.prisma.user.findUnique({ where: { email: input.email } });
    if (existingEmail)
        throw new errorHandler_1.AppError('Email already exists', 409);
    const existingPhone = await db_1.prisma.user.findUnique({ where: { phone: input.phone } });
    if (existingPhone)
        throw new errorHandler_1.AppError('Phone number already exists', 409);
    const passwordHash = await bcryptjs_1.default.hash(input.password, 12);
    const user = await db_1.prisma.user.create({
        data: {
            name: input.name,
            email: input.email,
            phone: input.phone,
            passwordHash,
            roleId: input.roleId,
            zoneId: input.zoneId,
            parentUserId: input.parentUserId,
            warehouseId: input.warehouseId,
            createdBy: input.createdBy,
            isVerified: true,
        },
        include: { role: true, zone: true },
    });
    return user;
}
async function listUsers(params) {
    const { page, limit, sort, order, search, roleId, role, zoneId, status } = params;
    const skip = (page - 1) * limit;
    const where = {
        status: status ? status : { not: 'DELETED' },
    };
    if (roleId)
        where.roleId = roleId;
    if (role)
        where.role = { name: role };
    if (zoneId)
        where.zoneId = zoneId;
    if (search) {
        where.OR = [
            { name: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search } },
        ];
    }
    const [users, total] = await Promise.all([
        db_1.prisma.user.findMany({
            where,
            include: { role: true, zone: true },
            skip,
            take: limit,
            orderBy: { [sort]: order },
        }),
        db_1.prisma.user.count({ where }),
    ]);
    return {
        users,
        meta: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
        },
    };
}
async function getUserById(id) {
    const user = await db_1.prisma.user.findUnique({
        where: { id },
        include: { role: true, zone: true, parentUser: { include: { role: true } } },
    });
    if (!user || user.status === 'DELETED') {
        throw new errorHandler_1.AppError('User not found', 404);
    }
    return user;
}
async function updateUser(id, data) {
    const user = await db_1.prisma.user.findUnique({ where: { id } });
    if (!user || user.status === 'DELETED')
        throw new errorHandler_1.AppError('User not found', 404);
    const updateData = {};
    if (data.name)
        updateData.name = data.name;
    if (data.email && data.email !== user.email) {
        const existing = await db_1.prisma.user.findUnique({ where: { email: data.email } });
        if (existing)
            throw new errorHandler_1.AppError('Email already exists', 409);
        updateData.email = data.email;
    }
    if (data.phone && data.phone !== user.phone) {
        const existing = await db_1.prisma.user.findUnique({ where: { phone: data.phone } });
        if (existing)
            throw new errorHandler_1.AppError('Phone already exists', 409);
        updateData.phone = data.phone;
    }
    if (data.password)
        updateData.passwordHash = await bcryptjs_1.default.hash(data.password, 12);
    if (data.roleId)
        updateData.role = { connect: { id: data.roleId } };
    if (data.zoneId)
        updateData.zone = { connect: { id: data.zoneId } };
    if (data.parentUserId)
        updateData.parentUser = { connect: { id: data.parentUserId } };
    if (data.warehouseId)
        updateData.warehouse = { connect: { id: data.warehouseId } };
    return db_1.prisma.user.update({
        where: { id },
        data: updateData,
        include: { role: true, zone: true },
    });
}
async function deleteUser(id) {
    const user = await db_1.prisma.user.findUnique({ where: { id } });
    if (!user || user.status === 'DELETED')
        throw new errorHandler_1.AppError('User not found', 404);
    return db_1.prisma.user.update({
        where: { id },
        data: { status: 'DELETED' },
    });
}
async function getUserHierarchy(userId) {
    const user = await db_1.prisma.user.findUnique({
        where: { id: userId },
        include: { role: true },
    });
    if (!user)
        throw new errorHandler_1.AppError('User not found', 404);
    const children = await db_1.prisma.user.findMany({
        where: { parentUserId: userId, status: { not: 'DELETED' } },
        include: { role: true },
    });
    const childNodes = await Promise.all(children.map(async (child) => getUserHierarchy(child.id)));
    return {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role.name,
        children: childNodes,
    };
}
async function getUserPerformance(userId) {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const [orderCount, totalSales, outstandingBalance] = await Promise.all([
        db_1.prisma.order.count({
            where: {
                OR: [{ salesmanId: userId }, { sellerId: userId }],
                createdAt: { gte: startOfMonth },
                status: { not: 'CANCELLED' },
            },
        }),
        db_1.prisma.order.aggregate({
            where: {
                OR: [{ salesmanId: userId }, { sellerId: userId }],
                createdAt: { gte: startOfMonth },
                status: { in: ['DELIVERED', 'DISPATCHED'] },
            },
            _sum: { grandTotal: true },
        }),
        db_1.prisma.outstandingLedger.aggregate({
            where: { userId },
            _sum: { balance: true },
        }),
    ]);
    return {
        mtdOrders: orderCount,
        mtdSales: totalSales._sum.grandTotal || 0,
        outstandingBalance: outstandingBalance._sum.balance || 0,
    };
}
//# sourceMappingURL=service.js.map
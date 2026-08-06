import bcrypt from 'bcryptjs';
import { prisma } from '../../config/db';
import { AppError } from '../../middleware/errorHandler';
import { PaginationMeta } from '../../types';
import { Prisma, RoleName } from '@prisma/client';

interface CreateUserInput {
  name: string;
  email: string;
  phone: string;
  password: string;
  roleId: string;
  zoneId?: string;
  parentUserId?: string;
  warehouseId?: string;
  createdBy: string;
}

interface ListUsersParams {
  page: number;
  limit: number;
  sort: string;
  order: 'asc' | 'desc';
  search?: string;
  roleId?: string;
  role?: string;
  zoneId?: string;
  status?: string;
}

interface UserListResult {
  users: Prisma.UserGetPayload<{ include: { role: true; zone: true } }>[];
  meta: PaginationMeta;
}

export async function createUser(input: CreateUserInput) {
  const existingEmail = await prisma.user.findUnique({ where: { email: input.email } });
  if (existingEmail) throw new AppError('Email already exists', 409);

  const existingPhone = await prisma.user.findUnique({ where: { phone: input.phone } });
  if (existingPhone) throw new AppError('Phone number already exists', 409);

  const passwordHash = await bcrypt.hash(input.password, 12);

  const user = await prisma.user.create({
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

export async function listUsers(params: ListUsersParams): Promise<UserListResult> {
  const { page, limit, sort, order, search, roleId, role, zoneId, status } = params;
  const skip = (page - 1) * limit;

  const where: Prisma.UserWhereInput = {
    status: status ? (status as Prisma.EnumStatusFilter['equals']) : { not: 'DELETED' },
  };

  if (roleId) where.roleId = roleId;
  if (role) where.role = { name: role as RoleName };
  if (zoneId) where.zoneId = zoneId;
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { email: { contains: search, mode: 'insensitive' } },
      { phone: { contains: search } },
    ];
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      include: { role: true, zone: true },
      skip,
      take: limit,
      orderBy: { [sort]: order },
    }),
    prisma.user.count({ where }),
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

export async function getUserById(id: string) {
  const user = await prisma.user.findUnique({
    where: { id },
    include: { role: true, zone: true, parentUser: { include: { role: true } } },
  });

  if (!user || user.status === 'DELETED') {
    throw new AppError('User not found', 404);
  }

  return user;
}

export async function updateUser(id: string, data: Partial<Omit<CreateUserInput, 'password' | 'createdBy'>> & { password?: string }) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user || user.status === 'DELETED') throw new AppError('User not found', 404);

  const updateData: Prisma.UserUpdateInput = {};
  if (data.name) updateData.name = data.name;
  if (data.email && data.email !== user.email) {
    const existing = await prisma.user.findUnique({ where: { email: data.email } });
    if (existing) throw new AppError('Email already exists', 409);
    updateData.email = data.email;
  }
  if (data.phone && data.phone !== user.phone) {
    const existing = await prisma.user.findUnique({ where: { phone: data.phone } });
    if (existing) throw new AppError('Phone already exists', 409);
    updateData.phone = data.phone;
  }
  if (data.password) updateData.passwordHash = await bcrypt.hash(data.password, 12);
  if (data.roleId) updateData.role = { connect: { id: data.roleId } };
  if (data.zoneId) updateData.zone = { connect: { id: data.zoneId } };
  if (data.parentUserId) updateData.parentUser = { connect: { id: data.parentUserId } };
  if (data.warehouseId) updateData.warehouse = { connect: { id: data.warehouseId } };

  return prisma.user.update({
    where: { id },
    data: updateData,
    include: { role: true, zone: true },
  });
}

export async function deleteUser(id: string) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user || user.status === 'DELETED') throw new AppError('User not found', 404);

  return prisma.user.update({
    where: { id },
    data: { status: 'DELETED' },
  });
}

export async function getUserHierarchy(userId: string): Promise<unknown> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { role: true },
  });

  if (!user) throw new AppError('User not found', 404);

  const children = await prisma.user.findMany({
    where: { parentUserId: userId, status: { not: 'DELETED' } },
    include: { role: true },
  });

  const childNodes = await Promise.all(
    children.map(async (child) => getUserHierarchy(child.id))
  );

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role.name,
    children: childNodes,
  };
}

export async function getUserPerformance(userId: string) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [orderCount, totalSales, outstandingBalance] = await Promise.all([
    prisma.order.count({
      where: {
        OR: [{ salesmanId: userId }, { sellerId: userId }],
        createdAt: { gte: startOfMonth },
        status: { not: 'CANCELLED' },
      },
    }),
    prisma.order.aggregate({
      where: {
        OR: [{ salesmanId: userId }, { sellerId: userId }],
        createdAt: { gte: startOfMonth },
        status: { in: ['DELIVERED', 'DISPATCHED'] },
      },
      _sum: { grandTotal: true },
    }),
    prisma.outstandingLedger.aggregate({
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

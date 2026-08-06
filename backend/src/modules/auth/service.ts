import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { prisma } from '../../config/db';
import redis from '../../config/redis';
import { env } from '../../config/env';
import { JwtPayload } from '../../types';
import { AppError } from '../../middleware/errorHandler';
import { RoleName } from '@prisma/client';

interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    name: string;
    email: string;
    phone: string;
    role: RoleName;
    zoneId: string | null;
    roleId?: string | null;
    territoryId?: string | null;
    party_id?: string | null;
    party_name?: string | null;
  };
}

interface CompanyLookupResult {
  success: boolean;
  data?: {
    accounts: Array<{
      userId: string;
      name?: string;
      email: string;
      role: string;
      partyId: string | null;
      companyName: string;
      companyCode: string | null;
    }>;
    multiple: boolean;
    byCompany?: Record<string, any[]>;
    totalCompanies?: number;
  };
  message?: string;
  hint?: string;
  availableRoles?: string[];
}

function generateTokens(user: { id: string; email: string; roleId: string; role: { name: RoleName }; zoneId: string | null }) {
  const payload: JwtPayload = {
    userId: user.id,
    email: user.email,
    roleId: user.roleId,
    roleName: user.role.name,
    zoneId: user.zoneId,
  };

  const accessToken = jwt.sign(payload as any, env.JWT_ACCESS_SECRET as any, {
    expiresIn: env.JWT_ACCESS_EXPIRY,
  } as any);

  const refreshToken = jwt.sign({ userId: user.id } as any, env.JWT_REFRESH_SECRET as any, {
    expiresIn: env.JWT_REFRESH_EXPIRY,
  } as any);

  return { accessToken, refreshToken };
}

async function storeRefreshToken(userId: string, refreshToken: string) {
  try {
    await redis.set(`refresh:${userId}`, refreshToken, 'EX', 7 * 24 * 60 * 60);
  } catch (error) {
    console.log('Redis unavailable, skipping refresh token storage');
  }
}

async function recordLoginActivity(userId: string, ipAddress: string, deviceInfo: string, isMobile: boolean, accessToken: string) {
  await prisma.user.update({
    where: { id: userId },
    data: { lastLogin: new Date() },
  });

  await prisma.loginActivity.create({
    data: {
      userId,
      ipAddress,
      deviceInfo,
      isMobile,
      sessionToken: accessToken.slice(-20),
    },
  });
}

export async function loginByEmail(email: string, password: string, ipAddress: string, deviceInfo: string, isMobile: boolean): Promise<LoginResult> {
  const user = await prisma.user.findUnique({
    where: { email },
    include: { role: true },
  });

  if (!user || user.status !== 'ACTIVE') {
    throw new AppError('Invalid email or password', 401);
  }

  const validPassword = await bcrypt.compare(password, user.passwordHash);
  if (!validPassword) {
    throw new AppError('Invalid email or password', 401);
  }

  const { accessToken, refreshToken } = generateTokens(user);
  await storeRefreshToken(user.id, refreshToken);
  await recordLoginActivity(user.id, ipAddress, deviceInfo, isMobile, accessToken);

  return {
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role.name,
      zoneId: user.zoneId,
    },
  };
}

export async function loginByPhone(phone: string, userId: string, password: string, ipAddress: string, deviceInfo: string, isMobile: boolean): Promise<LoginResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { role: true },
  });

  if (!user || user.status !== 'ACTIVE') {
    throw new AppError('Invalid credentials', 401);
  }

  // Verify phone matches
  if (user.phone !== phone) {
    throw new AppError('Invalid credentials', 401);
  }

  const validPassword = await bcrypt.compare(password, user.passwordHash);
  if (!validPassword) {
    throw new AppError('Invalid credentials', 401);
  }

  const { accessToken, refreshToken } = generateTokens(user);
  await storeRefreshToken(user.id, refreshToken);
  await recordLoginActivity(user.id, ipAddress, deviceInfo, isMobile, accessToken);

  return {
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: user.role.name,
      zoneId: user.zoneId,
    },
  };
}

export async function lookupCompanies(phone: string, role?: string): Promise<CompanyLookupResult> {
  const users = await prisma.user.findMany({
    where: {
      phone,
      status: 'ACTIVE',
      ...(role ? { role: { name: role as RoleName } } : {}),
    },
    include: { role: true },
  });

  if (users.length === 0) {
    return {
      success: false,
      message: 'No account found with this mobile number',
    };
  }

  const accounts = users.map(user => ({
    userId: user.id,
    name: user.name,
    email: user.email,
    role: user.role.name,
    partyId: user.parentUserId || null,
    companyName: user.name,
    companyCode: null,
  }));

  const availableRoles = [...new Set(users.map(u => u.role.name))];

  return {
    success: true,
    data: {
      accounts,
      multiple: accounts.length > 1,
      totalCompanies: accounts.length,
    },
    availableRoles,
  };
}

// Keep backward compatibility
export async function login(email: string, password: string, ipAddress: string, deviceInfo: string, isMobile: boolean): Promise<LoginResult> {
  return loginByEmail(email, password, ipAddress, deviceInfo, isMobile);
}

export async function refreshTokens(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
  let decoded: { userId: string };
  try {
    decoded = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET as any) as { userId: string };
  } catch {
    throw new AppError('Invalid refresh token', 401);
  }

  try {
    const stored = await redis.get(`refresh:${decoded.userId}`);
    if (!stored || stored !== refreshToken) {
      throw new AppError('Refresh token revoked or expired', 401);
    }
  } catch (error) {
    console.log('Redis unavailable for token validation, proceeding with JWT validation only');
  }

  const user = await prisma.user.findUnique({
    where: { id: decoded.userId },
    include: { role: true },
  });

  if (!user || user.status !== 'ACTIVE') {
    throw new AppError('User not found or inactive', 401);
  }

  const payload: JwtPayload = {
    userId: user.id,
    email: user.email,
    roleId: user.roleId,
    roleName: user.role.name,
    zoneId: user.zoneId,
  };

  const newAccessToken = jwt.sign(payload as any, env.JWT_ACCESS_SECRET as any, {
    expiresIn: env.JWT_ACCESS_EXPIRY,
  } as any);

  const newRefreshToken = jwt.sign({ userId: user.id } as any, env.JWT_REFRESH_SECRET as any, {
    expiresIn: env.JWT_REFRESH_EXPIRY,
  } as any);

  try {
    await redis.set(`refresh:${user.id}`, newRefreshToken, 'EX', 7 * 24 * 60 * 60);
  } catch (error) {
    console.log('Redis unavailable, skipping refresh token storage');
  }

  return { accessToken: newAccessToken, refreshToken: newRefreshToken };
}

export async function logout(userId: string): Promise<void> {
  try {
    await redis.del(`refresh:${userId}`);
    await redis.del(`permissions:${userId}`);
  } catch (error) {
    console.log('Redis unavailable for logout, skipping cache cleanup');
  }

  const activity = await prisma.loginActivity.findFirst({
    where: { userId, logoutTime: null },
    orderBy: { loginTime: 'desc' },
  });

  if (activity) {
    await prisma.loginActivity.update({
      where: { id: activity.id },
      data: { logoutTime: new Date() },
    });
  }
}

export async function forgotPassword(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || user.status !== 'ACTIVE') {
    return;
  }

  const token = crypto.randomBytes(32).toString('hex');
  try {
    await redis.set(`reset:${token}`, user.id, 'EX', 3600);
  } catch (error) {
    console.log('Redis unavailable, password reset may not work without Redis');
    throw new AppError('Password reset service temporarily unavailable', 503);
  }
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  let userId: string | null = null;
  try {
    userId = await redis.get(`reset:${token}`);
  } catch (error) {
    console.log('Redis unavailable for password reset');
    throw new AppError('Password reset service temporarily unavailable', 503);
  }
  
  if (!userId) {
    throw new AppError('Invalid or expired reset token', 400);
  }

  const passwordHash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash },
  });

  try {
    await redis.del(`reset:${token}`);
    await redis.del(`refresh:${userId}`);
  } catch (error) {
    console.log('Redis unavailable, skipping token cleanup');
  }
}

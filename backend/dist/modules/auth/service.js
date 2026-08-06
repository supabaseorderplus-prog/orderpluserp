"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loginByEmail = loginByEmail;
exports.loginByPhone = loginByPhone;
exports.lookupCompanies = lookupCompanies;
exports.login = login;
exports.refreshTokens = refreshTokens;
exports.logout = logout;
exports.forgotPassword = forgotPassword;
exports.resetPassword = resetPassword;
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const crypto_1 = __importDefault(require("crypto"));
const db_1 = require("../../config/db");
const redis_1 = __importDefault(require("../../config/redis"));
const env_1 = require("../../config/env");
const errorHandler_1 = require("../../middleware/errorHandler");
function generateTokens(user) {
    const payload = {
        userId: user.id,
        email: user.email,
        roleId: user.roleId,
        roleName: user.role.name,
        zoneId: user.zoneId,
    };
    const accessToken = jsonwebtoken_1.default.sign(payload, env_1.env.JWT_ACCESS_SECRET, {
        expiresIn: env_1.env.JWT_ACCESS_EXPIRY,
    });
    const refreshToken = jsonwebtoken_1.default.sign({ userId: user.id }, env_1.env.JWT_REFRESH_SECRET, {
        expiresIn: env_1.env.JWT_REFRESH_EXPIRY,
    });
    return { accessToken, refreshToken };
}
async function storeRefreshToken(userId, refreshToken) {
    try {
        await redis_1.default.set(`refresh:${userId}`, refreshToken, 'EX', 7 * 24 * 60 * 60);
    }
    catch (error) {
        console.log('Redis unavailable, skipping refresh token storage');
    }
}
async function recordLoginActivity(userId, ipAddress, deviceInfo, isMobile, accessToken) {
    await db_1.prisma.user.update({
        where: { id: userId },
        data: { lastLogin: new Date() },
    });
    await db_1.prisma.loginActivity.create({
        data: {
            userId,
            ipAddress,
            deviceInfo,
            isMobile,
            sessionToken: accessToken.slice(-20),
        },
    });
}
async function loginByEmail(email, password, ipAddress, deviceInfo, isMobile) {
    const user = await db_1.prisma.user.findUnique({
        where: { email },
        include: { role: true },
    });
    if (!user || user.status !== 'ACTIVE') {
        throw new errorHandler_1.AppError('Invalid email or password', 401);
    }
    const validPassword = await bcryptjs_1.default.compare(password, user.passwordHash);
    if (!validPassword) {
        throw new errorHandler_1.AppError('Invalid email or password', 401);
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
async function loginByPhone(phone, userId, password, ipAddress, deviceInfo, isMobile) {
    const user = await db_1.prisma.user.findUnique({
        where: { id: userId },
        include: { role: true },
    });
    if (!user || user.status !== 'ACTIVE') {
        throw new errorHandler_1.AppError('Invalid credentials', 401);
    }
    // Verify phone matches
    if (user.phone !== phone) {
        throw new errorHandler_1.AppError('Invalid credentials', 401);
    }
    const validPassword = await bcryptjs_1.default.compare(password, user.passwordHash);
    if (!validPassword) {
        throw new errorHandler_1.AppError('Invalid credentials', 401);
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
async function lookupCompanies(phone, role) {
    const users = await db_1.prisma.user.findMany({
        where: {
            phone,
            status: 'ACTIVE',
            ...(role ? { role: { name: role } } : {}),
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
async function login(email, password, ipAddress, deviceInfo, isMobile) {
    return loginByEmail(email, password, ipAddress, deviceInfo, isMobile);
}
async function refreshTokens(refreshToken) {
    let decoded;
    try {
        decoded = jsonwebtoken_1.default.verify(refreshToken, env_1.env.JWT_REFRESH_SECRET);
    }
    catch {
        throw new errorHandler_1.AppError('Invalid refresh token', 401);
    }
    try {
        const stored = await redis_1.default.get(`refresh:${decoded.userId}`);
        if (!stored || stored !== refreshToken) {
            throw new errorHandler_1.AppError('Refresh token revoked or expired', 401);
        }
    }
    catch (error) {
        console.log('Redis unavailable for token validation, proceeding with JWT validation only');
    }
    const user = await db_1.prisma.user.findUnique({
        where: { id: decoded.userId },
        include: { role: true },
    });
    if (!user || user.status !== 'ACTIVE') {
        throw new errorHandler_1.AppError('User not found or inactive', 401);
    }
    const payload = {
        userId: user.id,
        email: user.email,
        roleId: user.roleId,
        roleName: user.role.name,
        zoneId: user.zoneId,
    };
    const newAccessToken = jsonwebtoken_1.default.sign(payload, env_1.env.JWT_ACCESS_SECRET, {
        expiresIn: env_1.env.JWT_ACCESS_EXPIRY,
    });
    const newRefreshToken = jsonwebtoken_1.default.sign({ userId: user.id }, env_1.env.JWT_REFRESH_SECRET, {
        expiresIn: env_1.env.JWT_REFRESH_EXPIRY,
    });
    try {
        await redis_1.default.set(`refresh:${user.id}`, newRefreshToken, 'EX', 7 * 24 * 60 * 60);
    }
    catch (error) {
        console.log('Redis unavailable, skipping refresh token storage');
    }
    return { accessToken: newAccessToken, refreshToken: newRefreshToken };
}
async function logout(userId) {
    try {
        await redis_1.default.del(`refresh:${userId}`);
        await redis_1.default.del(`permissions:${userId}`);
    }
    catch (error) {
        console.log('Redis unavailable for logout, skipping cache cleanup');
    }
    const activity = await db_1.prisma.loginActivity.findFirst({
        where: { userId, logoutTime: null },
        orderBy: { loginTime: 'desc' },
    });
    if (activity) {
        await db_1.prisma.loginActivity.update({
            where: { id: activity.id },
            data: { logoutTime: new Date() },
        });
    }
}
async function forgotPassword(email) {
    const user = await db_1.prisma.user.findUnique({ where: { email } });
    if (!user || user.status !== 'ACTIVE') {
        return;
    }
    const token = crypto_1.default.randomBytes(32).toString('hex');
    try {
        await redis_1.default.set(`reset:${token}`, user.id, 'EX', 3600);
    }
    catch (error) {
        console.log('Redis unavailable, password reset may not work without Redis');
        throw new errorHandler_1.AppError('Password reset service temporarily unavailable', 503);
    }
}
async function resetPassword(token, newPassword) {
    let userId = null;
    try {
        userId = await redis_1.default.get(`reset:${token}`);
    }
    catch (error) {
        console.log('Redis unavailable for password reset');
        throw new errorHandler_1.AppError('Password reset service temporarily unavailable', 503);
    }
    if (!userId) {
        throw new errorHandler_1.AppError('Invalid or expired reset token', 400);
    }
    const passwordHash = await bcryptjs_1.default.hash(newPassword, 12);
    await db_1.prisma.user.update({
        where: { id: userId },
        data: { passwordHash },
    });
    try {
        await redis_1.default.del(`reset:${token}`);
        await redis_1.default.del(`refresh:${userId}`);
    }
    catch (error) {
        console.log('Redis unavailable, skipping token cleanup');
    }
}
//# sourceMappingURL=service.js.map
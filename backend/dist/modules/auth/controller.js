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
exports.login = login;
exports.companies = companies;
exports.refresh = refresh;
exports.logout = logout;
exports.forgotPassword = forgotPassword;
exports.resetPassword = resetPassword;
const zod_1 = require("zod");
const authService = __importStar(require("./service"));
const forgotPasswordSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
});
const resetPasswordSchema = zod_1.z.object({
    token: zod_1.z.string().min(1),
    newPassword: zod_1.z.string().min(8),
});
const emailLoginSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(6),
    role: zod_1.z.string().optional(),
});
const phoneLoginSchema = zod_1.z.object({
    phone: zod_1.z.string().min(1),
    userId: zod_1.z.string().uuid(),
    password: zod_1.z.string().min(6),
    role: zod_1.z.string().optional(),
});
const loginSchema = zod_1.z.union([emailLoginSchema, phoneLoginSchema]);
const refreshSchema = zod_1.z.object({
    refreshToken: zod_1.z.string(),
});
const companiesSchema = zod_1.z.object({
    phone: zod_1.z.string().min(1),
    role: zod_1.z.string().optional(),
});
async function login(req, res, next) {
    try {
        const body = loginSchema.parse(req.body);
        const ipAddress = req.ip || req.socket.remoteAddress || 'unknown';
        const deviceInfo = req.headers['user-agent'] || 'unknown';
        const isMobile = /mobile|android|iphone/i.test(deviceInfo);
        let result;
        if ('email' in body) {
            result = await authService.loginByEmail(body.email, body.password, ipAddress, deviceInfo, isMobile);
        }
        else {
            result = await authService.loginByPhone(body.phone, body.userId, body.password, ipAddress, deviceInfo, isMobile);
        }
        res.json({
            success: true,
            data: result,
            message: 'Login successful',
        });
    }
    catch (error) {
        next(error);
    }
}
async function companies(req, res, next) {
    try {
        const { phone, role } = companiesSchema.parse(req.query);
        const result = await authService.lookupCompanies(phone, role);
        res.json({
            success: result.success,
            data: result.data,
            message: result.message,
            hint: result.hint,
            availableRoles: result.availableRoles,
        });
    }
    catch (error) {
        next(error);
    }
}
async function refresh(req, res, next) {
    try {
        const { refreshToken } = refreshSchema.parse(req.body);
        const tokens = await authService.refreshTokens(refreshToken);
        res.json({
            success: true,
            data: tokens,
            message: 'Tokens refreshed',
        });
    }
    catch (error) {
        next(error);
    }
}
async function logout(req, res, next) {
    try {
        if (!req.user) {
            res.status(401).json({ success: false, data: null, message: 'Not authenticated' });
            return;
        }
        await authService.logout(req.user.userId);
        res.json({
            success: true,
            data: null,
            message: 'Logged out successfully',
        });
    }
    catch (error) {
        next(error);
    }
}
async function forgotPassword(req, res, next) {
    try {
        const { email } = forgotPasswordSchema.parse(req.body);
        await authService.forgotPassword(email);
        res.json({
            success: true,
            data: null,
            message: 'If the email exists, a password reset link has been sent',
        });
    }
    catch (error) {
        next(error);
    }
}
async function resetPassword(req, res, next) {
    try {
        const { token, newPassword } = resetPasswordSchema.parse(req.body);
        await authService.resetPassword(token, newPassword);
        res.json({
            success: true,
            data: null,
            message: 'Password has been reset successfully',
        });
    }
    catch (error) {
        next(error);
    }
}
//# sourceMappingURL=controller.js.map
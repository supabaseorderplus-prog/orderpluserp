import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as authService from './service';
import { AuthRequest } from '../../types';

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8),
});

const emailLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  role: z.string().optional(),
});

const phoneLoginSchema = z.object({
  phone: z.string().min(1),
  userId: z.string().uuid(),
  password: z.string().min(6),
  role: z.string().optional(),
});

const loginSchema = z.union([emailLoginSchema, phoneLoginSchema]);

const refreshSchema = z.object({
  refreshToken: z.string(),
});

const companiesSchema = z.object({
  phone: z.string().min(1),
  role: z.string().optional(),
});

export async function login(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = loginSchema.parse(req.body);
    const ipAddress = req.ip || req.socket.remoteAddress || 'unknown';
    const deviceInfo = req.headers['user-agent'] || 'unknown';
    const isMobile = /mobile|android|iphone/i.test(deviceInfo);

    let result;
    if ('email' in body) {
      result = await authService.loginByEmail(body.email, body.password, ipAddress, deviceInfo, isMobile);
    } else {
      result = await authService.loginByPhone(body.phone, body.userId, body.password, ipAddress, deviceInfo, isMobile);
    }

    res.json({
      success: true,
      data: result,
      message: 'Login successful',
    });
  } catch (error) {
    next(error);
  }
}

export async function companies(req: Request, res: Response, next: NextFunction): Promise<void> {
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
  } catch (error) {
    next(error);
  }
}

export async function refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { refreshToken } = refreshSchema.parse(req.body);
    const tokens = await authService.refreshTokens(refreshToken);

    res.json({
      success: true,
      data: tokens,
      message: 'Tokens refreshed',
    });
  } catch (error) {
    next(error);
  }
}

export async function logout(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
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
    } catch (error) {
      next(error);
    }
  }

export async function forgotPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email } = forgotPasswordSchema.parse(req.body);
    await authService.forgotPassword(email);

    res.json({
      success: true,
      data: null,
      message: 'If the email exists, a password reset link has been sent',
    });
  } catch (error) {
    next(error);
  }
}

export async function resetPassword(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { token, newPassword } = resetPasswordSchema.parse(req.body);
    await authService.resetPassword(token, newPassword);

    res.json({
      success: true,
      data: null,
      message: 'Password has been reset successfully',
    });
  } catch (error) {
    next(error);
  }
}

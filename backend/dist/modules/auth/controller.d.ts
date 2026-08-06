import { Request, Response, NextFunction } from 'express';
import { AuthRequest } from '../../types';
export declare function login(req: Request, res: Response, next: NextFunction): Promise<void>;
export declare function companies(req: Request, res: Response, next: NextFunction): Promise<void>;
export declare function refresh(req: Request, res: Response, next: NextFunction): Promise<void>;
export declare function logout(req: AuthRequest, res: Response, next: NextFunction): Promise<void>;
export declare function forgotPassword(req: Request, res: Response, next: NextFunction): Promise<void>;
export declare function resetPassword(req: Request, res: Response, next: NextFunction): Promise<void>;
//# sourceMappingURL=controller.d.ts.map
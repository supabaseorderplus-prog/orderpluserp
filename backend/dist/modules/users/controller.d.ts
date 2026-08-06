import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../types';
export declare function listUsers(req: AuthRequest, res: Response, next: NextFunction): Promise<void>;
export declare function createUser(req: AuthRequest, res: Response, next: NextFunction): Promise<void>;
export declare function getUser(req: AuthRequest, res: Response, next: NextFunction): Promise<void>;
export declare function updateUser(req: AuthRequest, res: Response, next: NextFunction): Promise<void>;
export declare function deleteUser(req: AuthRequest, res: Response, next: NextFunction): Promise<void>;
export declare function getUserHierarchy(req: AuthRequest, res: Response, next: NextFunction): Promise<void>;
export declare function getUserPerformance(req: AuthRequest, res: Response, next: NextFunction): Promise<void>;
//# sourceMappingURL=controller.d.ts.map
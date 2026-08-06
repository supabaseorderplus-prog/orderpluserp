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
export declare function loginByEmail(email: string, password: string, ipAddress: string, deviceInfo: string, isMobile: boolean): Promise<LoginResult>;
export declare function loginByPhone(phone: string, userId: string, password: string, ipAddress: string, deviceInfo: string, isMobile: boolean): Promise<LoginResult>;
export declare function lookupCompanies(phone: string, role?: string): Promise<CompanyLookupResult>;
export declare function login(email: string, password: string, ipAddress: string, deviceInfo: string, isMobile: boolean): Promise<LoginResult>;
export declare function refreshTokens(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
}>;
export declare function logout(userId: string): Promise<void>;
export declare function forgotPassword(email: string): Promise<void>;
export declare function resetPassword(token: string, newPassword: string): Promise<void>;
export {};
//# sourceMappingURL=service.d.ts.map
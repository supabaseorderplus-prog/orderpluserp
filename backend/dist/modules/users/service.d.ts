import { PaginationMeta } from '../../types';
import { Prisma } from '@prisma/client';
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
    users: Prisma.UserGetPayload<{
        include: {
            role: true;
            zone: true;
        };
    }>[];
    meta: PaginationMeta;
}
export declare function createUser(input: CreateUserInput): Promise<{
    role: {
        status: import("@prisma/client").$Enums.Status;
        name: import("@prisma/client").$Enums.RoleName;
        id: string;
        description: string | null;
        createdAt: Date;
        updatedAt: Date;
    };
    zone: {
        status: import("@prisma/client").$Enums.Status;
        name: string;
        id: string;
        createdAt: Date;
        updatedAt: Date;
        createdBy: string | null;
        stateId: string;
        districtId: string;
        isActive: boolean;
    } | null;
} & {
    status: import("@prisma/client").$Enums.Status;
    name: string;
    id: string;
    createdAt: Date;
    updatedAt: Date;
    roleId: string;
    email: string;
    phone: string;
    passwordHash: string;
    zoneId: string | null;
    parentUserId: string | null;
    warehouseId: string | null;
    fcmToken: string | null;
    lastLogin: Date | null;
    isVerified: boolean;
    avatarUrl: string | null;
    createdBy: string | null;
}>;
export declare function listUsers(params: ListUsersParams): Promise<UserListResult>;
export declare function getUserById(id: string): Promise<{
    role: {
        status: import("@prisma/client").$Enums.Status;
        name: import("@prisma/client").$Enums.RoleName;
        id: string;
        description: string | null;
        createdAt: Date;
        updatedAt: Date;
    };
    zone: {
        status: import("@prisma/client").$Enums.Status;
        name: string;
        id: string;
        createdAt: Date;
        updatedAt: Date;
        createdBy: string | null;
        stateId: string;
        districtId: string;
        isActive: boolean;
    } | null;
    parentUser: ({
        role: {
            status: import("@prisma/client").$Enums.Status;
            name: import("@prisma/client").$Enums.RoleName;
            id: string;
            description: string | null;
            createdAt: Date;
            updatedAt: Date;
        };
    } & {
        status: import("@prisma/client").$Enums.Status;
        name: string;
        id: string;
        createdAt: Date;
        updatedAt: Date;
        roleId: string;
        email: string;
        phone: string;
        passwordHash: string;
        zoneId: string | null;
        parentUserId: string | null;
        warehouseId: string | null;
        fcmToken: string | null;
        lastLogin: Date | null;
        isVerified: boolean;
        avatarUrl: string | null;
        createdBy: string | null;
    }) | null;
} & {
    status: import("@prisma/client").$Enums.Status;
    name: string;
    id: string;
    createdAt: Date;
    updatedAt: Date;
    roleId: string;
    email: string;
    phone: string;
    passwordHash: string;
    zoneId: string | null;
    parentUserId: string | null;
    warehouseId: string | null;
    fcmToken: string | null;
    lastLogin: Date | null;
    isVerified: boolean;
    avatarUrl: string | null;
    createdBy: string | null;
}>;
export declare function updateUser(id: string, data: Partial<Omit<CreateUserInput, 'password' | 'createdBy'>> & {
    password?: string;
}): Promise<{
    role: {
        status: import("@prisma/client").$Enums.Status;
        name: import("@prisma/client").$Enums.RoleName;
        id: string;
        description: string | null;
        createdAt: Date;
        updatedAt: Date;
    };
    zone: {
        status: import("@prisma/client").$Enums.Status;
        name: string;
        id: string;
        createdAt: Date;
        updatedAt: Date;
        createdBy: string | null;
        stateId: string;
        districtId: string;
        isActive: boolean;
    } | null;
} & {
    status: import("@prisma/client").$Enums.Status;
    name: string;
    id: string;
    createdAt: Date;
    updatedAt: Date;
    roleId: string;
    email: string;
    phone: string;
    passwordHash: string;
    zoneId: string | null;
    parentUserId: string | null;
    warehouseId: string | null;
    fcmToken: string | null;
    lastLogin: Date | null;
    isVerified: boolean;
    avatarUrl: string | null;
    createdBy: string | null;
}>;
export declare function deleteUser(id: string): Promise<{
    status: import("@prisma/client").$Enums.Status;
    name: string;
    id: string;
    createdAt: Date;
    updatedAt: Date;
    roleId: string;
    email: string;
    phone: string;
    passwordHash: string;
    zoneId: string | null;
    parentUserId: string | null;
    warehouseId: string | null;
    fcmToken: string | null;
    lastLogin: Date | null;
    isVerified: boolean;
    avatarUrl: string | null;
    createdBy: string | null;
}>;
export declare function getUserHierarchy(userId: string): Promise<unknown>;
export declare function getUserPerformance(userId: string): Promise<{
    mtdOrders: number;
    mtdSales: number | Prisma.Decimal;
    outstandingBalance: number | Prisma.Decimal;
}>;
export {};
//# sourceMappingURL=service.d.ts.map
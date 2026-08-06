"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.schemeQueue = void 0;
exports.scheduleSchemeProgressJob = scheduleSchemeProgressJob;
const bull_1 = __importDefault(require("bull"));
const db_1 = require("../config/db");
const env_1 = require("../config/env");
const logger_1 = require("../utils/logger");
let schemeQueue = null;
exports.schemeQueue = schemeQueue;
try {
    exports.schemeQueue = schemeQueue = new bull_1.default('scheme-progress', env_1.env.REDIS_URL, {
        defaultJobOptions: { removeOnComplete: 50, removeOnFail: 20 },
    });
    schemeQueue.process(async () => {
        logger_1.logger.info('[SchemeProgressJob] Recalculating scheme progress...');
        const now = new Date();
        const activeSchemes = await db_1.prisma.scheme.findMany({
            where: {
                isActive: true,
                status: 'ACTIVE',
                validFrom: { lte: now },
                validTo: { gte: now },
            },
        });
        let updated = 0;
        for (const scheme of activeSchemes) {
            const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
            const eligibleUsers = await db_1.prisma.user.findMany({
                where: {
                    role: { name: scheme.applicableRole },
                    status: 'ACTIVE',
                    ...(scheme.zoneId ? { zoneId: scheme.zoneId } : {}),
                },
                select: { id: true },
            });
            for (const user of eligibleUsers) {
                const sales = await db_1.prisma.order.aggregate({
                    where: {
                        OR: [{ salesmanId: user.id }, { sellerId: user.id }, { buyerId: user.id }],
                        createdAt: { gte: scheme.validFrom > startOfMonth ? scheme.validFrom : startOfMonth },
                        status: { in: ['DELIVERED', 'DISPATCHED'] },
                    },
                    _sum: { grandTotal: true },
                });
                const currentValue = Number(sales._sum.grandTotal || 0);
                const conditions = scheme.conditions;
                const targetValue = conditions?.targetSales || Number(scheme.rewardValue) * 10;
                const progressPercent = Math.min((currentValue / targetValue) * 100, 100);
                const isEligible = progressPercent >= 100;
                await db_1.prisma.schemeProgress.upsert({
                    where: { schemeId_userId: { schemeId: scheme.id, userId: user.id } },
                    create: {
                        schemeId: scheme.id,
                        userId: user.id,
                        currentValue,
                        targetValue,
                        progressPercent,
                        isEligible,
                    },
                    update: {
                        currentValue,
                        progressPercent,
                        isEligible,
                        lastUpdated: new Date(),
                    },
                });
                if (progressPercent >= 85 && progressPercent < 100) {
                    const existing = await db_1.prisma.notification.findFirst({
                        where: {
                            userId: user.id,
                            type: 'SCHEME',
                            referenceId: scheme.id,
                            createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
                        },
                    });
                    if (!existing) {
                        await db_1.prisma.notification.create({
                            data: {
                                userId: user.id,
                                title: `Almost there! ${scheme.name}`,
                                body: `You're ${Math.round(progressPercent)}% of the way to your reward!`,
                                type: 'SCHEME',
                                referenceId: scheme.id,
                                referenceType: 'scheme',
                                deliveryChannel: 'IN_APP',
                            },
                        });
                    }
                }
                updated++;
            }
        }
        logger_1.logger.info(`[SchemeProgressJob] Updated ${updated} progress records for ${activeSchemes.length} schemes.`);
    });
}
catch (error) {
    logger_1.logger.warn('[SchemeProgressJob] Failed to initialize (Redis may be unavailable):', error);
}
function scheduleSchemeProgressJob() {
    if (!schemeQueue)
        return;
    schemeQueue.add({}, { repeat: { cron: '0 0 * * *' } });
    logger_1.logger.info('[SchemeProgressJob] Scheduled daily at midnight');
}
//# sourceMappingURL=schemeProgressJob.js.map
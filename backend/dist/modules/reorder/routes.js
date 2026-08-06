"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const db_1 = require("../../config/db");
const auth_1 = require("../../middleware/auth");
const rbac_1 = require("../../middleware/rbac");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
router.get('/settings/:retailerId', (0, rbac_1.checkPermission)('orders', 'view'), async (req, res, next) => {
    try {
        const retailerId = req.params.retailerId;
        const settings = await db_1.prisma.reorderSetting.findMany({
            where: { retailerId, status: 'ACTIVE' },
            include: { product: { select: { id: true, name: true, sku: true } } },
        });
        res.json({ success: true, data: settings, message: 'Reorder settings retrieved' });
    }
    catch (error) {
        next(error);
    }
});
router.put('/settings/:retailerId', (0, rbac_1.checkPermission)('orders', 'edit'), async (req, res, next) => {
    try {
        const retailerId = req.params.retailerId;
        const { settings } = zod_1.z.object({
            settings: zod_1.z.array(zod_1.z.object({
                productId: zod_1.z.string().uuid(),
                minThreshold: zod_1.z.number().int().positive(),
                preferredQuantity: zod_1.z.number().int().positive(),
                autoReorderEnabled: zod_1.z.boolean(),
            })),
        }).parse(req.body);
        const results = await Promise.all(settings.map((s) => db_1.prisma.reorderSetting.upsert({
            where: { retailerId_productId: { retailerId, productId: s.productId } },
            create: { retailerId, ...s },
            update: s,
        })));
        res.json({ success: true, data: results, message: 'Reorder settings updated' });
    }
    catch (error) {
        next(error);
    }
});
router.post('/toggle', (0, rbac_1.checkPermission)('orders', 'edit'), async (req, res, next) => {
    try {
        const { retailerId, enabled } = zod_1.z.object({ retailerId: zod_1.z.string().uuid(), enabled: zod_1.z.boolean() }).parse(req.body);
        await db_1.prisma.reorderSetting.updateMany({ where: { retailerId }, data: { autoReorderEnabled: enabled } });
        res.json({ success: true, data: null, message: `Auto reorder ${enabled ? 'enabled' : 'disabled'}` });
    }
    catch (error) {
        next(error);
    }
});
router.get('/triggers', (0, rbac_1.checkPermission)('orders', 'view'), async (req, res, next) => {
    try {
        const triggers = await db_1.prisma.reorderTrigger.findMany({
            where: { status: { in: ['PENDING', 'NOTIFIED'] } },
            include: { retailer: { select: { id: true, name: true, phone: true } }, product: { select: { id: true, name: true, sku: true } } },
            orderBy: { triggeredAt: 'desc' },
        });
        res.json({ success: true, data: triggers, message: 'Reorder triggers retrieved' });
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
//# sourceMappingURL=routes.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const zod_1 = require("zod");
const db_1 = require("../../config/db");
const auth_1 = require("../../middleware/auth");
const rbac_1 = require("../../middleware/rbac");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
const priceListItemSchema = zod_1.z.object({
    productId: zod_1.z.string().uuid(),
    unitPrice: zod_1.z.number().positive(),
    minMarginFloor: zod_1.z.number().optional(),
    maxMarginCeiling: zod_1.z.number().optional(),
});
const priceListSchema = zod_1.z.object({
    name: zod_1.z.string().min(1).max(200),
    code: zod_1.z.string().min(1).max(50),
    applicablePartyType: zod_1.z.enum(['CNF', 'SUPER_DEALER', 'RETAILER']),
    partyId: zod_1.z.string().uuid().nullable().optional(),
    validFrom: zod_1.z.string(),
    validTo: zod_1.z.string().nullable().optional(),
    isCurrent: zod_1.z.boolean().optional(),
    notes: zod_1.z.string().optional(),
    status: zod_1.z.enum(['ACTIVE', 'INACTIVE', 'DELETED']).optional(),
    items: zod_1.z.array(priceListItemSchema),
});
router.get('/', (0, rbac_1.checkPermission)('pricing', 'view'), async (req, res, next) => {
    try {
        const priceLists = await db_1.prisma.priceList.findMany({
            where: { status: { not: 'DELETED' } },
            include: {
                party: true,
                items: {
                    include: { product: true },
                },
            },
            orderBy: { createdAt: 'desc' },
        });
        res.json({ success: true, data: priceLists, message: 'Price lists retrieved' });
    }
    catch (error) {
        next(error);
    }
});
router.post('/', (0, rbac_1.checkPermission)('pricing', 'create'), async (req, res, next) => {
    try {
        const { items, ...data } = priceListSchema.parse(req.body);
        const priceList = await db_1.prisma.priceList.create({
            data: {
                name: data.name,
                code: data.code,
                applicablePartyType: data.applicablePartyType,
                partyId: data.partyId || null,
                validFrom: new Date(data.validFrom),
                validTo: data.validTo ? new Date(data.validTo) : null,
                isCurrent: data.isCurrent ?? true,
                notes: data.notes || null,
                status: data.status || 'ACTIVE',
                createdBy: req.user.userId,
                items: {
                    create: items.map(item => ({
                        productId: item.productId,
                        unitPrice: item.unitPrice,
                        minMarginFloor: item.minMarginFloor || null,
                        maxMarginCeiling: item.maxMarginCeiling || null,
                    })),
                },
            },
            include: {
                party: true,
                items: {
                    include: { product: true },
                },
            },
        });
        res.status(201).json({ success: true, data: priceList, message: 'Price list created' });
    }
    catch (error) {
        next(error);
    }
});
router.get('/:id', (0, rbac_1.checkPermission)('pricing', 'view'), async (req, res, next) => {
    try {
        const id = req.params.id;
        const priceList = await db_1.prisma.priceList.findUnique({
            where: { id },
            include: {
                party: true,
                items: {
                    include: { product: true },
                },
            },
        });
        if (!priceList || priceList.status === 'DELETED') {
            res.status(404).json({ success: false, data: null, message: 'Price list not found' });
            return;
        }
        res.json({ success: true, data: priceList, message: 'Price list retrieved' });
    }
    catch (error) {
        next(error);
    }
});
router.put('/:id', (0, rbac_1.checkPermission)('pricing', 'edit'), async (req, res, next) => {
    try {
        const id = req.params.id;
        const { items, ...data } = priceListSchema.partial().extend({ items: zod_1.z.array(priceListItemSchema).optional() }).parse(req.body);
        // Delete existing items
        await db_1.prisma.priceListItem.deleteMany({
            where: { priceListId: id },
        });
        const priceList = await db_1.prisma.priceList.update({
            where: { id },
            data: {
                name: data.name,
                code: data.code,
                applicablePartyType: data.applicablePartyType,
                partyId: data.partyId !== undefined ? data.partyId : undefined,
                validFrom: data.validFrom ? new Date(data.validFrom) : undefined,
                validTo: data.validTo !== undefined ? (data.validTo ? new Date(data.validTo) : null) : undefined,
                isCurrent: data.isCurrent,
                notes: data.notes,
                status: data.status,
                items: items ? {
                    create: items.map(item => ({
                        productId: item.productId,
                        unitPrice: item.unitPrice,
                        minMarginFloor: item.minMarginFloor || null,
                        maxMarginCeiling: item.maxMarginCeiling || null,
                    })),
                } : undefined,
            },
            include: {
                party: true,
                items: {
                    include: { product: true },
                },
            },
        });
        res.json({ success: true, data: priceList, message: 'Price list updated' });
    }
    catch (error) {
        next(error);
    }
});
router.delete('/:id', (0, rbac_1.checkPermission)('pricing', 'delete'), async (req, res, next) => {
    try {
        const id = req.params.id;
        await db_1.prisma.priceList.update({ where: { id }, data: { status: 'DELETED' } });
        res.json({ success: true, data: null, message: 'Price list deleted' });
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
//# sourceMappingURL=routes.js.map
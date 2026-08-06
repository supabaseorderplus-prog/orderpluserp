"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../../config/db");
const auth_1 = require("../../middleware/auth");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
router.get('/', async (req, res, next) => {
    try {
        const q = req.query;
        const page = parseInt(q.page || '1', 10);
        const limit = parseInt(q.limit || '20', 10);
        const [notifications, total] = await Promise.all([
            db_1.prisma.notification.findMany({
                where: { userId: req.user.userId },
                skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' },
            }),
            db_1.prisma.notification.count({ where: { userId: req.user.userId } }),
        ]);
        const unreadCount = await db_1.prisma.notification.count({ where: { userId: req.user.userId, isRead: false } });
        res.json({ success: true, data: { notifications, unreadCount }, message: 'Notifications retrieved', meta: { page, limit, total, totalPages: Math.ceil(total / limit) } });
    }
    catch (error) {
        next(error);
    }
});
router.put('/:id/read', async (req, res, next) => {
    try {
        const id = req.params.id;
        await db_1.prisma.notification.update({ where: { id }, data: { isRead: true, readAt: new Date() } });
        res.json({ success: true, data: null, message: 'Notification marked as read' });
    }
    catch (error) {
        next(error);
    }
});
router.put('/read-all', async (req, res, next) => {
    try {
        await db_1.prisma.notification.updateMany({ where: { userId: req.user.userId, isRead: false }, data: { isRead: true, readAt: new Date() } });
        res.json({ success: true, data: null, message: 'All notifications marked as read' });
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
//# sourceMappingURL=routes.js.map
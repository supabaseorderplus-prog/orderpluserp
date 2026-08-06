"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../../config/db");
const auth_1 = require("../../middleware/auth");
const rbac_1 = require("../../middleware/rbac");
const router = (0, express_1.Router)();
router.use(auth_1.authenticate);
router.get('/dashboard', (0, rbac_1.checkPermission)('analytics', 'view'), async (req, res, next) => {
    try {
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const ownership = (0, rbac_1.filterByOwnership)(req);
        const orderWhere = {};
        if (ownership.zoneId)
            orderWhere.zoneId = ownership.zoneId;
        if (ownership.userId)
            orderWhere.salesmanId = ownership.userId;
        const [todaySales, mtdSales, activeOrders, outstanding, lowStock, activeSalesmen] = await Promise.all([
            db_1.prisma.order.aggregate({ where: { ...orderWhere, createdAt: { gte: startOfDay }, status: { in: ['DELIVERED', 'DISPATCHED'] } }, _sum: { grandTotal: true } }),
            db_1.prisma.order.aggregate({ where: { ...orderWhere, createdAt: { gte: startOfMonth }, status: { in: ['DELIVERED', 'DISPATCHED'] } }, _sum: { grandTotal: true } }),
            db_1.prisma.order.count({ where: { ...orderWhere, status: { in: ['PENDING', 'APPROVED', 'PROCESSING', 'DISPATCHED'] } } }),
            db_1.prisma.outstandingLedger.aggregate({ _sum: { balance: true } }),
            db_1.prisma.$queryRaw `SELECT COUNT(*) as count FROM inventory WHERE quantity_on_hand <= reorder_threshold AND status = 'ACTIVE'`,
            db_1.prisma.gpsLog.findMany({ where: { timestamp: { gte: new Date(Date.now() - 30 * 60 * 1000) } }, distinct: ['userId'], select: { userId: true } }),
        ]);
        res.json({
            success: true,
            data: {
                todaySales: Number(todaySales._sum.grandTotal || 0),
                mtdSales: Number(mtdSales._sum.grandTotal || 0),
                activeOrders,
                outstanding: Number(outstanding._sum.balance || 0),
                lowStockItems: Number(lowStock[0]?.count || 0),
                activeSalesmen: activeSalesmen.length,
            },
            message: 'Dashboard data retrieved',
        });
    }
    catch (error) {
        next(error);
    }
});
router.get('/sales/daily', (0, rbac_1.checkPermission)('analytics', 'view'), async (req, res, next) => {
    try {
        const zone = req.query.zone;
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const sales = await db_1.prisma.$queryRaw `
      SELECT DATE(created_at) as date, SUM(grand_total) as total, COUNT(*) as order_count
      FROM orders
      WHERE created_at >= ${thirtyDaysAgo}
        AND status IN ('DELIVERED', 'DISPATCHED')
        ${zone ? db_1.prisma.$queryRaw `AND zone_id = ${zone}` : db_1.prisma.$queryRaw ``}
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `;
        res.json({ success: true, data: sales, message: 'Daily sales retrieved' });
    }
    catch (error) {
        next(error);
    }
});
router.get('/sales/monthly', (0, rbac_1.checkPermission)('analytics', 'view'), async (req, res, next) => {
    try {
        const year = parseInt(req.query.year || String(new Date().getFullYear()), 10);
        const startDate = new Date(year, 0, 1);
        const endDate = new Date(year + 1, 0, 1);
        const sales = await db_1.prisma.$queryRaw `
      SELECT EXTRACT(MONTH FROM created_at) as month, SUM(grand_total) as total, COUNT(*) as order_count
      FROM orders
      WHERE created_at >= ${startDate} AND created_at < ${endDate}
        AND status IN ('DELIVERED', 'DISPATCHED')
      GROUP BY EXTRACT(MONTH FROM created_at)
      ORDER BY month ASC
    `;
        res.json({ success: true, data: sales, message: 'Monthly sales retrieved' });
    }
    catch (error) {
        next(error);
    }
});
router.get('/zones/performance', (0, rbac_1.checkPermission)('analytics', 'view'), async (_req, res, next) => {
    try {
        const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
        const performance = await db_1.prisma.$queryRaw `
      SELECT z.id, z.name as zone_name, 
        COALESCE(SUM(o.grand_total), 0) as total_sales,
        COUNT(o.id) as order_count
      FROM zones z
      LEFT JOIN orders o ON z.id = o.zone_id AND o.created_at >= ${startOfMonth} AND o.status IN ('DELIVERED', 'DISPATCHED')
      WHERE z.status = 'ACTIVE'
      GROUP BY z.id, z.name
      ORDER BY total_sales DESC
    `;
        res.json({ success: true, data: performance, message: 'Zone performance retrieved' });
    }
    catch (error) {
        next(error);
    }
});
router.get('/salesman/leaderboard', (0, rbac_1.checkPermission)('analytics', 'view'), async (_req, res, next) => {
    try {
        const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
        const leaderboard = await db_1.prisma.$queryRaw `
      SELECT u.id, u.name, 
        COALESCE(SUM(o.grand_total), 0) as total_sales,
        COUNT(o.id) as order_count
      FROM users u
      JOIN roles r ON u.role_id = r.id
      LEFT JOIN orders o ON u.id = o.salesman_id AND o.created_at >= ${startOfMonth} AND o.status IN ('DELIVERED', 'DISPATCHED')
      WHERE r.name = 'SALESMAN' AND u.status = 'ACTIVE'
      GROUP BY u.id, u.name
      ORDER BY total_sales DESC
      LIMIT 10
    `;
        res.json({ success: true, data: leaderboard, message: 'Leaderboard retrieved' });
    }
    catch (error) {
        next(error);
    }
});
router.get('/distributors/performance', (0, rbac_1.checkPermission)('analytics', 'view'), async (_req, res, next) => {
    try {
        const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
        const performance = await db_1.prisma.$queryRaw `
      SELECT u.id, u.name,
        COALESCE(SUM(o.grand_total), 0) as total_sales,
        COUNT(o.id) as order_count
      FROM users u
      JOIN roles r ON u.role_id = r.id
      LEFT JOIN orders o ON u.id = o.seller_id AND o.created_at >= ${startOfMonth} AND o.status IN ('DELIVERED', 'DISPATCHED')
      WHERE r.name IN ('DISTRIBUTOR', 'SUB_DISTRIBUTOR') AND u.status = 'ACTIVE'
      GROUP BY u.id, u.name
      ORDER BY total_sales DESC
    `;
        res.json({ success: true, data: performance, message: 'Distributor performance retrieved' });
    }
    catch (error) {
        next(error);
    }
});
router.get('/inventory/valuation', (0, rbac_1.checkPermission)('analytics', 'view'), async (_req, res, next) => {
    try {
        const valuation = await db_1.prisma.$queryRaw `
      SELECT w.name as warehouse_name,
        SUM(i.quantity_on_hand * p.base_price) as total_value,
        COUNT(DISTINCT i.product_id) as product_count
      FROM inventory i
      JOIN products p ON i.product_id = p.id
      JOIN warehouses w ON i.warehouse_id = w.id
      WHERE i.status = 'ACTIVE'
      GROUP BY w.id, w.name
      ORDER BY total_value DESC
    `;
        res.json({ success: true, data: valuation, message: 'Inventory valuation retrieved' });
    }
    catch (error) {
        next(error);
    }
});
exports.default = router;
//# sourceMappingURL=routes.js.map
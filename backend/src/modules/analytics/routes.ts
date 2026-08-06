import { Router } from 'express';
import { Response, NextFunction } from 'express';
import { prisma } from '../../config/db';
import { authenticate } from '../../middleware/auth';
import { checkPermission, filterByOwnership } from '../../middleware/rbac';
import { AuthRequest } from '../../types';
import { RoleName } from '@prisma/client';

const router = Router();
router.use(authenticate);

router.get('/dashboard', checkPermission('analytics', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const ownership = filterByOwnership(req);
    const orderWhere: Record<string, unknown> = {};
    if (ownership.zoneId) orderWhere.zoneId = ownership.zoneId;
    if (ownership.userId) orderWhere.salesmanId = ownership.userId;

    const [todaySales, mtdSales, activeOrders, outstanding, lowStock, activeSalesmen] = await Promise.all([
      prisma.order.aggregate({ where: { ...orderWhere, createdAt: { gte: startOfDay }, status: { in: ['DELIVERED', 'DISPATCHED'] } } as any, _sum: { grandTotal: true } }),
      prisma.order.aggregate({ where: { ...orderWhere, createdAt: { gte: startOfMonth }, status: { in: ['DELIVERED', 'DISPATCHED'] } } as any, _sum: { grandTotal: true } }),
      prisma.order.count({ where: { ...orderWhere, status: { in: ['PENDING', 'APPROVED', 'PROCESSING', 'DISPATCHED'] } } as any }),
      prisma.outstandingLedger.aggregate({ _sum: { balance: true } }),
      prisma.$queryRaw`SELECT COUNT(*) as count FROM inventory WHERE quantity_on_hand <= reorder_threshold AND status = 'ACTIVE'` as Promise<Array<{ count: bigint }>>,
      prisma.gpsLog.findMany({ where: { timestamp: { gte: new Date(Date.now() - 30 * 60 * 1000) } }, distinct: ['userId'], select: { userId: true } }),
    ]);

    res.json({
      success: true,
      data: {
        todaySales: Number(todaySales._sum.grandTotal || 0),
        mtdSales: Number(mtdSales._sum.grandTotal || 0),
        activeOrders,
        outstanding: Number(outstanding._sum.balance || 0),
        lowStockItems: Number((lowStock as Array<{ count: bigint }>)[0]?.count || 0),
        activeSalesmen: activeSalesmen.length,
      },
      message: 'Dashboard data retrieved',
    });
  } catch (error) { next(error); }
});

router.get('/sales/daily', checkPermission('analytics', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const zone = req.query.zone as string | undefined;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const sales = await prisma.$queryRaw`
      SELECT DATE(created_at) as date, SUM(grand_total) as total, COUNT(*) as order_count
      FROM orders
      WHERE created_at >= ${thirtyDaysAgo}
        AND status IN ('DELIVERED', 'DISPATCHED')
        ${zone ? prisma.$queryRaw`AND zone_id = ${zone}` : prisma.$queryRaw``}
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `;

    res.json({ success: true, data: sales, message: 'Daily sales retrieved' });
  } catch (error) { next(error); }
});

router.get('/sales/monthly', checkPermission('analytics', 'view'), async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const year = parseInt(req.query.year as string || String(new Date().getFullYear()), 10);
    const startDate = new Date(year, 0, 1);
    const endDate = new Date(year + 1, 0, 1);

    const sales = await prisma.$queryRaw`
      SELECT EXTRACT(MONTH FROM created_at) as month, SUM(grand_total) as total, COUNT(*) as order_count
      FROM orders
      WHERE created_at >= ${startDate} AND created_at < ${endDate}
        AND status IN ('DELIVERED', 'DISPATCHED')
      GROUP BY EXTRACT(MONTH FROM created_at)
      ORDER BY month ASC
    `;

    res.json({ success: true, data: sales, message: 'Monthly sales retrieved' });
  } catch (error) { next(error); }
});

router.get('/zones/performance', checkPermission('analytics', 'view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const performance = await prisma.$queryRaw`
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
  } catch (error) { next(error); }
});

router.get('/salesman/leaderboard', checkPermission('analytics', 'view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const leaderboard = await prisma.$queryRaw`
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
  } catch (error) { next(error); }
});

router.get('/distributors/performance', checkPermission('analytics', 'view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const performance = await prisma.$queryRaw`
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
  } catch (error) { next(error); }
});

router.get('/inventory/valuation', checkPermission('analytics', 'view'), async (_req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const valuation = await prisma.$queryRaw`
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
  } catch (error) { next(error); }
});

export default router;

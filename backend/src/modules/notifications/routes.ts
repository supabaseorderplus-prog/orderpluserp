import { Router } from 'express';
import { Response, NextFunction } from 'express';
import { prisma } from '../../config/db';
import { authenticate } from '../../middleware/auth';
import { AuthRequest, PaginationQuery } from '../../types';

const router = Router();
router.use(authenticate);

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const q = req.query as PaginationQuery;
    const page = parseInt(q.page || '1', 10);
    const limit = parseInt(q.limit || '20', 10);

    const [notifications, total] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: req.user!.userId },
        skip: (page - 1) * limit, take: limit, orderBy: { createdAt: 'desc' },
      }),
      prisma.notification.count({ where: { userId: req.user!.userId } }),
    ]);

    const unreadCount = await prisma.notification.count({ where: { userId: req.user!.userId, isRead: false } });

    res.json({ success: true, data: { notifications, unreadCount }, message: 'Notifications retrieved', meta: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) { next(error); }
});

router.put('/:id/read', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const id = req.params.id as string;
    await prisma.notification.update({ where: { id }, data: { isRead: true, readAt: new Date() } });
    res.json({ success: true, data: null, message: 'Notification marked as read' });
  } catch (error) { next(error); }
});

router.put('/read-all', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    await prisma.notification.updateMany({ where: { userId: req.user!.userId, isRead: false }, data: { isRead: true, readAt: new Date() } });
    res.json({ success: true, data: null, message: 'All notifications marked as read' });
  } catch (error) { next(error); }
});

export default router;

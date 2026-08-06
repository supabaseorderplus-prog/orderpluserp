import { Router } from 'express';
import * as userController from './controller';
import { authenticate } from '../../middleware/auth';
import { checkPermission } from '../../middleware/rbac';

const router = Router();

router.use(authenticate);

router.get('/', checkPermission('users', 'view'), userController.listUsers);
router.post('/', checkPermission('users', 'create'), userController.createUser);
router.get('/:id', checkPermission('users', 'view'), userController.getUser);
router.put('/:id', checkPermission('users', 'edit'), userController.updateUser);
router.delete('/:id', checkPermission('users', 'delete'), userController.deleteUser);
router.get('/:id/hierarchy', checkPermission('users', 'view'), userController.getUserHierarchy);
router.get('/:id/performance', checkPermission('users', 'view'), userController.getUserPerformance);

export default router;

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import morgan from 'morgan';
import { env } from './config/env';
import { errorHandler } from './middleware/errorHandler';
import { apiLimiter } from './middleware/rateLimiter';

import authRoutes from './modules/auth/routes';
import userRoutes from './modules/users/routes';
import productRoutes from './modules/products/routes';
import pricingRoutes from './modules/pricing/routes';
import geographyRoutes from './modules/geography/routes';
import routeRoutes from './modules/routes/routes';
import trackingRoutes from './modules/tracking/routes';
import dutyRoutes from './modules/duty/routes';
import orderRoutes from './modules/orders/routes';
import inventoryRoutes from './modules/inventory/routes';
import schemeRoutes from './modules/schemes/routes';
import reorderRoutes from './modules/reorder/routes';
import paymentRoutes from './modules/payments/routes';
import analyticsRoutes from './modules/analytics/routes';
import notificationRoutes from './modules/notifications/routes';
import exportRoutes from './modules/export/routes';
import partyRoutes from './modules/parties/routes';
import priceListRoutes from './modules/price-lists/routes';
import tdConfigRoutes from './modules/td-config/routes';
import creditAnalysisRoutes from './modules/credit-analysis/routes';

const app = express();

app.use(helmet());
app.use(cors({
  origin: env.CORS_ORIGIN.split(','),
  credentials: true,
}));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(morgan('combined'));
app.use(apiLimiter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/products', productRoutes);
app.use('/api/v1/pricing', pricingRoutes);
app.use('/api/v1/geography', geographyRoutes);
app.use('/api/v1/routes', routeRoutes);
app.use('/api/v1/tracking', trackingRoutes);
app.use('/api/v1/duty', dutyRoutes);
app.use('/api/v1/orders', orderRoutes);
app.use('/api/v1/inventory', inventoryRoutes);
app.use('/api/v1/schemes', schemeRoutes);
app.use('/api/v1/reorder', reorderRoutes);
app.use('/api/v1/payments', paymentRoutes);
app.use('/api/v1/analytics', analyticsRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/export', exportRoutes);
app.use('/api/v1/parties', partyRoutes);
app.use('/api/v1/price-lists', priceListRoutes);
app.use('/api/v1/td-config', tdConfigRoutes);
app.use('/api/v1/credit-analysis', creditAnalysisRoutes);

app.use(errorHandler);

export default app;

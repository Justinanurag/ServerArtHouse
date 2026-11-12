import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import dotenv from 'dotenv';
import connectDB from './config/db.js';
import authRoutes from './routes/auth.route.js';
import invoiceRoutes from './routes/invoice.route.js';
import customerRoutes from './routes/customer.route.js';
import productRoutes from './routes/product.route.js';
import serviceRoutes from './routes/service.route.js';
import categoryRoutes from './routes/category.route.js';
import subCategoryRoutes from './routes/subCategory.route.js';
import quotationRoutes from './routes/quotation.route.js';
import returnsalesRoutes from './routes/returnSales.router.js';
import subscriptionRoutes from './routes/subscription.route.js';
import membershipRoutes from './routes/membership.routes.js';
import spaceRoutes from './routes/space.route.js';
import spaceBookingRoutes from './routes/spaceBooking.route.js';
import foodRoutes from './routes/food.route.js';
import catalogueRoutes from './routes/catalogue.route.js';
import purchaseRoutes from './routes/purchase.router.js';
import purchaseOrderRoutes from './routes/PurchaseOrder.router.js';
import purchaseReturnRoutes from './routes/purchaseReturn.router.js';
import vendorRoutes from './routes/vendor.router.js';
import inventoryRoutes from './routes/Inventory.router.js';
import walletRoutes from './routes/wallet.router.js';
import couponRoutes from './routes/coupon.route.js';
import spaceOfferRoutes from './routes/spaceOffer.route.js';
import giftCardRoutes from './routes/giftCard.route.js';
import companyRoutes from './routes/company.route.js';
import affiliateRoutes from './routes/affiliate.route.js';
import accessRoutes from './routes/access.route.js';
import cspRouters from './routes/csp.route.js';
import hapRouters from './routes/hap.route.js';
import customerAuthRoutes from './modules/customer/routes/auth.routes.js';
import {customerErrorHandler} from './modules/customer/middlewares/errorHandler.js';
import path from 'path';
import {fileURLToPath} from 'url';
import sentAnnouncement from './routes/sendAnnouncement.router.js';
import expenceRoutes from './routes/expence.router.js';
import expenceCategoryRoutes from './routes/expenceCategory.router.js';
import dashboardRoutes from './routes/dashboard.route.js';
import staffCommissionRoutes from './routes/staffCommission.route.js'
import leadRouters from './routes/lead.Route.js';
import additionalServiceRoutes from './routes/additionalService.route.js';
import publicGiftCardRoutes from './routes/publicGiftCard.route.js';
import exhibitionRoutes from './routes/exhibition.routes.js';
import publicExhibitionRoutes from './routes/publicExhibition.route.js';
import publicInvoiceRoutes from './routes/publicInvoice.route.js';
import allBookingRoutes from './routes/allBooking.route.js';
import bookingOverviewRoutes from './routes/bookingOverview.route.js';
import {checkRedisConnection} from './config/redisConnection.js';
import segmentRoutes from './routes/segment.routes.js';
import erpActivityRoutes from './routes/erpActivity.route.js';
import {activityLogger, requestContext} from './middlewares/activityLogger.middleware.js';

// import activityRoutes from './routes/activity.route.js';

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({path: path.join(__dirname, '.env')});

const app = express();
const PORT = process.env.PORT || 3000;

// Behind Vercel's proxy: use X-Forwarded-For so rate limits apply per visitor, not globally.
app.set('trust proxy', 1);

// Middleware
app.use(
  helmet({
    crossOriginResourcePolicy: {policy: 'cross-origin'},
  }),
);
const allowedOrigins = [
  "https://www.woowooarthouse.in",
  "https://woowooarthouse.in",
  "https://admin.woowooarthouse.in",
  "https://api.woowooarthouse.in",
  "https://woo-woo-erp.vercel.app",
  "https://woo-woo-erp-5iyu.vercel.app",
  "http://localhost:5173",
  "http://localhost:5174",
  ...String(process.env.CORS_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests without an Origin header, such as server-to-server calls.
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204,
  }),
);
app.use(cookieParser());
app.use(express.json({limit: '2mb'}));
app.use(express.urlencoded({extended: true, limit: '2mb'}));

// Lightweight NoSQL injection guard (Express 5 compatible)
app.use((req, _res, next) => {
  const stripKeys = value => {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(stripKeys);
    for (const key of Object.keys(value)) {
      if (key.startsWith('$') || key.includes('.')) {
        delete value[key];
      } else if (typeof value[key] === 'object') {
        stripKeys(value[key]);
      }
    }
    return value;
  };
  if (req.body) stripKeys(req.body);
  next();
});

// Queries use bufferCommands: false, so a request must wait for MongoDB.
app.use(async (req, res, next) => {
  if (req.path === '/' && req.method === 'GET') return next();
  try {
    await connectDB();
    next();
  } catch (error) {
    console.error('MongoDB not ready:', error?.message || error);
    if (!res.headersSent) {
      res.status(503).json({
        success: false,
        message: 'Database is not ready. Please try again.',
      });
    }
  }
});
app.use(requestContext);
app.use(activityLogger);
app.use('/api/activities', erpActivityRoutes);

// Admin / existing ERP APIs 
app.use('/auth', authRoutes);
app.use('/invoice', invoiceRoutes);
app.use('/quotation', quotationRoutes);
app.use('/customer', customerRoutes);
app.use('/product', productRoutes);
app.use('/segment',segmentRoutes);
app.use('/services', serviceRoutes);
app.use('/additional-services', additionalServiceRoutes);
app.use('/api/additional-services', additionalServiceRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/subCategories', subCategoryRoutes);
app.use('/returnsales', returnsalesRoutes);
app.use('/subscriptions', subscriptionRoutes);
app.use('/membership', membershipRoutes);
app.use('/space', spaceRoutes);
app.use('/space-bookings', spaceBookingRoutes);
app.use('/all-booking',allBookingRoutes);
app.use('/booking-overview', bookingOverviewRoutes);
app.use('/food', foodRoutes);
app.use('/catalogue', catalogueRoutes);
app.use('/purchase', purchaseRoutes);
app.use('/purchaseOrder', purchaseOrderRoutes);
app.use('/purchaseReturn', purchaseReturnRoutes);
app.use('/vendor', vendorRoutes);
app.use('/inventory', inventoryRoutes);

app.use('/wallet', walletRoutes);
app.use('/coupon', couponRoutes);
app.use('/space-offers', spaceOfferRoutes);
app.use('/gift-cards', giftCardRoutes);
app.use('/company', companyRoutes);
app.use('/affiliate', affiliateRoutes);
app.use('/access', accessRoutes);
app.use('/public/gift-cards', publicGiftCardRoutes);
app.use('/public/exhibition', publicExhibitionRoutes);
app.use('/public/invoices', publicInvoiceRoutes);

//CSP APIs
app.use('/csp', cspRouters);

app.use('/hap', hapRouters);
// Customer portal auth APIs — isolated namespace (does not conflict with admin /customer)
app.use('/api/customer', customerAuthRoutes);
//send whatsapp announcement
app.use('/api/announcement', sentAnnouncement);
//Expences module
app.use('/api/expences', expenceRoutes);
app.use('/api/expences/category', expenceCategoryRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/api/commission',staffCommissionRoutes);
app.use('/api/lead',leadRouters);

app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

//Exhibition module
app.use('/api/exhibition',exhibitionRoutes);

app.get("/", (req, res) => {
  res.send("🚀 Server is live and running...");
});

// Warm the connection on boot. Requests still await connectDB() above.
void connectDB().catch(() => {});
app.use(customerErrorHandler);

app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);
  await checkRedisConnection();
});

// Export the Express application for Vercel.
export default app;

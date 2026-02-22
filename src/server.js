import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { diagnoseRouter } from './routes/diagnose.js';
import { healthRouter } from './routes/health.js';
import { scriptRouter } from './routes/script.js';
import { resultsRouter } from './routes/results.js';
import { paymentRouter } from './routes/payment.js';
import { webhooksRouter } from './routes/webhooks.js';
import { landingRouter } from './landing.js';
import { initDB } from './db.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Security & parsing
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
    },
  },
}));
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (req.path !== '/api/health') {
      console.log(`${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
    }
  });
  next();
});

// Routes
app.use('/api', diagnoseRouter);
app.use('/api', healthRouter);
app.use('/api', paymentRouter);  // POST /api/checkout, /api/webhook/lemonsqueezy
app.use('/', paymentRouter);    // GET /pay/:fixId — payment page
app.use('/', webhooksRouter);   // POST /webhooks/resend — inbound email
app.use('/', scriptRouter);     // GET /fix — diagnostic script
app.use('/', resultsRouter);    // GET /results/:fixId — web results page
app.use('/', landingRouter);    // GET / — landing page (must be last)

app.listen(PORT, async () => {
  console.log(`🦞 ClawFix v${process.env.npm_package_version || '0.1.0'} running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   AI: ${process.env.AI_PROVIDER || 'none'} / ${process.env.AI_MODEL || 'pattern-matching only'}`);
  console.log(`   DB: ${process.env.DATABASE_URL ? 'PostgreSQL' : 'in-memory only'}`);
  
  // Initialize database
  await initDB();
});

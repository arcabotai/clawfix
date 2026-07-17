import express from 'express';
import helmet from 'helmet';
import { pathToFileURL } from 'node:url';
import { diagnoseRouter } from './routes/diagnose.js';
import { healthRouter } from './routes/health.js';
import { scriptRouter } from './routes/script.js';
import { resultsRouter } from './routes/results.js';
import { paymentRouter } from './routes/payment.js';
import { webhooksRouter } from './routes/webhooks.js';
import { chatRouter } from './routes/chat.js';
import { landingRouter } from './landing.js';
import { initDB } from './db.js';
import { APP_VERSION } from './version.js';
import { createServerStarter } from './server-start.js';

export const app = express();
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
      workerSrc: ["'self'", "blob:"],
    },
  },
}));
// Browser clients are same-origin. Do not expose paid AI routes cross-origin.
app.use(express.json({ limit: '512kb' }));

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
app.use('/api', chatRouter);     // POST /api/chat — interactive TUI chat
app.use('/api', paymentRouter);  // POST /api/checkout, /api/webhook/lemonsqueezy
app.use('/', paymentRouter);    // GET /pay/:fixId — payment page
app.use('/', webhooksRouter);   // POST /webhooks/resend — inbound email
app.use('/', scriptRouter);     // GET /fix — diagnostic script
app.use('/', resultsRouter);    // GET /results/:fixId — web results page
app.use('/', landingRouter);    // GET / — landing page (must be last)

export const startServer = createServerStarter({
  defaultPort: PORT,
  defaultListen: app.listen.bind(app),
  defaultInitialize: initDB,
  onListening(port) {
    console.log(`🦞 ClawFix v${APP_VERSION} running on port ${port}`);
    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`   AI: ${process.env.AI_PROVIDER || 'none'} / ${process.env.AI_MODEL || 'pattern-matching only'}`);
    console.log(`   DB: ${process.env.DATABASE_URL ? 'PostgreSQL' : 'in-memory only'}`);
  },
});

const isMainModule = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  startServer().catch((error) => {
    console.error(`❌ ClawFix failed to start: ${error.message}`);
    process.exitCode = 1;
  });
}

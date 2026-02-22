import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { diagnoseRouter } from './routes/diagnose.js';
import { healthRouter } from './routes/health.js';
import { scriptRouter } from './routes/script.js';
import { landingRouter } from './landing.js';

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
    },
  },
}));
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Routes
app.use('/api', diagnoseRouter);
app.use('/api', healthRouter);
app.use('/', scriptRouter);  // GET /fix — diagnostic script
app.use('/', landingRouter);  // GET / — landing page (must be after /fix)

app.listen(PORT, () => {
  console.log(`🦞 ClawFix running on port ${PORT}`);
});

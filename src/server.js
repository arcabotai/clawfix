import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { diagnoseRouter } from './routes/diagnose.js';
import { healthRouter } from './routes/health.js';
import { scriptRouter } from './routes/script.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Security & parsing
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Routes
app.use('/api', diagnoseRouter);
app.use('/api', healthRouter);
app.use('/', scriptRouter);

// Root
app.get('/', (req, res) => {
  res.json({
    name: 'ClawFix',
    tagline: 'AI-powered OpenClaw repair',
    version: '0.1.0',
    endpoints: {
      'GET /fix': 'Download diagnostic script',
      'POST /api/diagnose': 'Submit diagnostic data for AI analysis',
      'GET /api/health': 'Health check',
    }
  });
});

app.listen(PORT, () => {
  console.log(`🦞 ClawFix running on port ${PORT}`);
});

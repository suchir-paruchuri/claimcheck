import cookieParser from 'cookie-parser';
import express, { type ErrorRequestHandler } from 'express';
import { authRouter, requireAuth } from './auth/auth';
import { config } from './config';
import { billsRouter } from './routes/bills';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // Minimal CORS for the separately hosted React app (cookies require an exact origin).
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', config.clientOrigin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.use('/auth', authRouter);
  app.use('/bills', requireAuth, billsRouter);

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  };
  app.use(onError);
  return app;
}

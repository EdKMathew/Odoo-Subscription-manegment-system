import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { errorHandler, HttpError } from './lib/errors';
import authRoutes from './routes/auth';
import userRoutes from './routes/users';
import catalogRoutes from './routes/catalog';

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: config.clientUrl, credentials: true, exposedHeaders: ['X-Response-Time'] }));
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());

// CSRF defence: state-changing requests must be JSON or multipart, which a
// cross-site HTML form cannot send without a CORS preflight.
app.use((req, _res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const type = req.headers['content-type'] ?? '';
    if (!type.startsWith('application/json') && !type.startsWith('multipart/form-data')) {
      return next(new HttpError(415, 'Unsupported content type'));
    }
  }
  next();
});

// Response time header, shown in the UI to prove query speed.
app.use((_req, res, next) => {
  const start = process.hrtime.bigint();
  const end = res.end.bind(res);
  res.end = ((...args: Parameters<typeof res.end>) => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (!res.headersSent) res.setHeader('X-Response-Time', `${ms.toFixed(1)}ms`);
    return end(...args);
  }) as typeof res.end;
  next();
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/catalog', catalogRoutes);

app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));
app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`API listening on http://localhost:${config.port}`);
});

import express from 'express';
import cors from 'cors';
import batchRoutes from './routes/batchRoutes.js';
import healthRoutes from './routes/healthRoutes.js';
import { config } from './config/env.js';

const app = express();

// CORS configuration supporting localhost, Vercel deployments, and custom domains
const defaultLocalOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:4173',
  'http://127.0.0.1:4173'
];

const configuredOrigins = config.clientUrl
  ? config.clientUrl.split(',').map((url) => url.trim().replace(/\/+$/, ''))
  : [];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow non-browser requests (e.g. mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);

    const isWildcard = config.clientUrl === '*' || configuredOrigins.includes('*');
    const isLocal = defaultLocalOrigins.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    const isConfigured = configuredOrigins.includes(origin);
    const isVercel = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.vercel\.app$/i.test(origin);

    if (isWildcard || isLocal || isConfigured || isVercel) {
      return callback(null, true);
    }

    // Default permissive reflection to prevent CORS errors on custom frontend domains
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Batch-Id', 'Accept', 'Origin']
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// API routes
app.use('/api/health', healthRoutes);
app.use('/api/batches', batchRoutes);

// Root informational endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'FASTBATCH — Smart Bulk Video Merger API',
    description: 'Auto-detect series numbers, group related videos, merge using FFmpeg with lossless stream copy or transcode fallback.',
    docs: '/api/health'
  });
});

// 404 handler
app.use((req, res, next) => {
  res.status(404).json({ error: `Cannot ${req.method} ${req.originalUrl}` });
});

// Centralized error handling middleware
app.use((err, req, res, next) => {
  console.error('[Express Global Error Handler]', err);

  if (err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `File too large. Maximum batch limit is ${config.maxBatchSizeMB} MB.` });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }

  const statusCode = err.statusCode || 500;
  return res.status(statusCode).json({
    error: err.message || 'An internal server error occurred.'
  });
});

export default app;

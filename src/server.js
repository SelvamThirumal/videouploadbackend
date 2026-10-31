import app from './app.js';
import { config, validateEnv } from './config/env.js';
import { connectDB } from './config/db.js';
import { cleanupService } from './services/cleanupService.js';
import { MergeJob } from './models/MergeJob.js';

async function bootstrap() {
  validateEnv();

  // Connect to MongoDB
  try {
    await connectDB();
  } catch (err) {
    console.error('[Fatal Error] Database connection failed. Exiting.', err);
    process.exit(1);
  }

  // Recover any jobs left in "processing" state from a previous crash/restart
  try {
    const recovered = await MergeJob.updateMany(
      { status: 'processing' },
      { $set: { status: 'failed', stage: 'Server restarted during processing' } }
    );
    if (recovered.modifiedCount > 0) {
      console.log(`[Queue Recovery] Reset ${recovered.modifiedCount} interrupted job(s) from previous server run.`);
    }
  } catch (e) {
    console.warn('[Queue Recovery Warning] Could not recover stale jobs:', e.message);
  }

  // Start background expiration & cleanup worker
  cleanupService.start();

  const server = app.listen(config.port, () => {
    console.log(`\n🚀 FASTBATCH Video Merger Server is running at http://localhost:${config.port}`);
    console.log(`📡 Ready to accept bulk folder uploads & merges.\n`);
  });

  // Support massive 1 TB uploads without premature connection timeouts
  server.timeout = 0; // Infinite socket timeout for streaming GB/TB uploads
  server.requestTimeout = 0;
  server.keepAliveTimeout = 300000;
  server.headersTimeout = 305000;

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[Server] Shutting down gracefully...');
    cleanupService.stop();
    server.close(() => {
      console.log('[Server] Closed remaining connections.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap();

import express from 'express';
import fs from 'fs';
import { config } from '../config/env.js';

const router = express.Router();

router.get('/', async (req, res) => {
  let diskFreeBytes = null;
  let diskTotalBytes = null;
  try {
    const stats = await fs.promises.statfs(config.tempDir);
    diskFreeBytes = stats.bfree * stats.bsize;
    diskTotalBytes = stats.blocks * stats.bsize;
  } catch (_) {}

  res.json({
    status: 'ok',
    service: 'FASTBATCH Video Merger API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    config: {
      maxBatchSizeMB: config.maxBatchSizeMB,
      maxBatchSizeGB: Math.round(config.maxBatchSizeMB / 1024),
      maxFilesPerBatch: config.maxFilesPerBatch,
      fileRetentionMinutes: config.fileRetentionMinutes,
      maxConcurrentMerges: config.maxConcurrentMerges
    },
    storage: {
      configuredMaxBatchMB: config.maxBatchSizeMB,
      diskFreeBytes,
      diskTotalBytes
    }
  });
});

export default router;

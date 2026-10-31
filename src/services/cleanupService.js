import fs from 'fs';
import path from 'path';
import { Batch } from '../models/Batch.js';
import { VideoFile } from '../models/VideoFile.js';
import { MergeJob } from '../models/MergeJob.js';
import { config } from '../config/env.js';

class CleanupService {
  constructor() {
    this.timer = null;
    this.isRunning = false;
    // Map of batchId -> active lease count
    this.activeDownloadLeases = new Map();
  }

  /**
   * Acquires a lease for an active download.
   * Prevents cleanup from deleting files while a stream is in progress.
   */
  acquireDownloadLease(batchId) {
    const current = this.activeDownloadLeases.get(batchId) || 0;
    this.activeDownloadLeases.set(batchId, current + 1);
  }

  /**
   * Releases an active download lease.
   */
  releaseDownloadLease(batchId) {
    const current = this.activeDownloadLeases.get(batchId) || 0;
    if (current <= 1) {
      this.activeDownloadLeases.delete(batchId);
    } else {
      this.activeDownloadLeases.set(batchId, current - 1);
    }
  }

  /**
   * Checks if a batch currently has active download streams.
   */
  hasActiveDownload(batchId) {
    return (this.activeDownloadLeases.get(batchId) || 0) > 0;
  }

  /**
   * Starts the background cleanup worker.
   */
  start() {
    if (this.timer) return;
    console.log('[Cleanup Worker] Starting 10-minute expiration & cleanup service...');
    // Initial run to clean up after server restart
    this.performCleanup().catch(err => console.error('[Cleanup Worker] Initial run error:', err));
    // Interval check every 20 seconds
    this.timer = setInterval(() => {
      this.performCleanup().catch(err => console.error('[Cleanup Worker] Periodic check error:', err));
    }, 20 * 1000);
  }

  /**
   * Stops the cleanup worker.
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Executes the cleanup cycle.
   */
  async performCleanup() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const now = new Date();

      // 1. Find batches that have expired (now >= expiresAt)
      const expiredBatches = await Batch.find({
        expiresAt: { $ne: null, $lte: now },
        cleanupStatus: { $ne: 'cleaned' }
      });

      for (const batch of expiredBatches) {
        // Check active download lease
        if (this.hasActiveDownload(batch.batchId)) {
          console.log(`[Cleanup Worker] Batch ${batch.batchId} has expired, but has active download stream(s). Postponing disk deletion until stream ends.`);
          continue;
        }

        await this.cleanBatch(batch.batchId);
      }

      // 2. Find abandoned uploads (created > tempFileRetentionMinutes ago and still 'uploading' or 'failed')
      const abandonedThreshold = new Date(now.getTime() - config.tempFileRetentionMinutes * 60 * 1000);
      const abandonedBatches = await Batch.find({
        status: { $in: ['uploading', 'failed'] },
        createdAt: { $lte: abandonedThreshold },
        cleanupStatus: { $ne: 'cleaned' }
      });

      for (const batch of abandonedBatches) {
        if (!this.hasActiveDownload(batch.batchId)) {
          console.log(`[Cleanup Worker] Cleaning abandoned batch ${batch.batchId}...`);
          await this.cleanBatch(batch.batchId);
        }
      }

    } catch (err) {
      console.error('[Cleanup Worker Error]', err);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Safely removes all disk files and database records for a given batchId.
   */
  async cleanBatch(batchId) {
    try {
      console.log(`[Cleanup Worker] Deleting files and records for batch: ${batchId}`);

      // 1. Mark batch as expired immediately so new downloads are rejected
      await Batch.updateOne(
        { batchId },
        { $set: { status: 'expired', cleanupStatus: 'pending' } }
      );

      // 2. Remove physical directory
      const batchFolder = path.join(config.tempDir, batchId);
      if (fs.existsSync(batchFolder)) {
        await fs.promises.rm(batchFolder, { recursive: true, force: true });
        console.log(`[Cleanup Worker] Successfully removed directory: ${batchFolder}`);
      }

      // 3. Remove DB records
      await VideoFile.deleteMany({ batchId });
      await MergeJob.deleteMany({ batchId });
      await Batch.updateOne(
        { batchId },
        { $set: { cleanupStatus: 'cleaned' } }
      );

      console.log(`[Cleanup Worker] Cleaned batch ${batchId} completely.`);
      return true;
    } catch (err) {
      console.error(`[Cleanup Worker Error] Failed to clean batch ${batchId}:`, err);
      await Batch.updateOne(
        { batchId },
        { $set: { cleanupStatus: 'failed' } }
      );
      return false;
    }
  }
}

export const cleanupService = new CleanupService();

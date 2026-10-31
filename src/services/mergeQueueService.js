import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import { Batch } from '../models/Batch.js';
import { VideoFile } from '../models/VideoFile.js';
import { MergeJob } from '../models/MergeJob.js';
import { mergeVideoSeries } from './ffmpegService.js';
import { config } from '../config/env.js';

class MergeQueueService extends EventEmitter {
  constructor() {
    super();
    this.activeWorkers = 0;
    this.maxConcurrent = config.maxConcurrentMerges;
    this.abortControllers = new Map(); // jobId -> AbortController
    this.batchAbortControllers = new Map(); // batchId -> Set<jobId>
    this.isProcessing = false;
  }

  /**
   * Enqueues series merge jobs for a batch.
   * @param {string} batchId 
   * @param {Array<{ seriesId: string, partFileIds: Array<string> }>} seriesConfigs 
   */
  async enqueueBatch(batchId, seriesConfigs) {
    const batch = await Batch.findOne({ batchId });
    if (!batch) {
      throw new Error(`Batch ${batchId} not found`);
    }

    if (batch.status === 'expired') {
      throw new Error('This batch has expired and cannot be processed.');
    }

    const createdJobs = [];

    // Create MergeJob records in MongoDB
    for (const configItem of seriesConfigs) {
      const { seriesId, partFileIds } = configItem;
      if (!partFileIds || partFileIds.length === 0) continue;

      // Safe sanitized output filename: e.g. "5.1.1.mp4"
      const safeSeriesName = seriesId.replace(/[\\/:*?"<>|]/g, '_');
      const outputFileName = `${safeSeriesName}.mp4`;
      const batchOutputDir = path.join(config.tempDir, batchId, 'output');

      if (!fs.existsSync(batchOutputDir)) {
        await fs.promises.mkdir(batchOutputDir, { recursive: true });
      }

      const outputFilePath = path.join(batchOutputDir, outputFileName);

      const job = new MergeJob({
        batchId,
        seriesId,
        inputFileIds: partFileIds,
        outputFilePath,
        outputFileName,
        status: 'queued',
        progress: 0,
        stage: 'Queued'
      });

      await job.save();
      createdJobs.push(job);
    }

    batch.status = 'processing';
    await batch.save();

    this.emit('batch_updated', { batchId, status: 'processing' });

    // Trigger queue processing across all available worker slots
    this.triggerQueue();

    return createdJobs;
  }

  /**
   * Triggers processing to saturate all available concurrency slots.
   */
  async triggerQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (this.activeWorkers < this.maxConcurrent) {
        const started = await this.startNextJob();
        if (!started) break;
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Main queue processing tick (backward compatible).
   */
  async processNext() {
    return this.triggerQueue();
  }

  /**
   * Atomically claims and begins executing the next queued job.
   */
  async startNextJob() {
    if (this.activeWorkers >= this.maxConcurrent) {
      return false;
    }

    // Atomically claim next queued job to eliminate race conditions
    const job = await MergeJob.findOneAndUpdate(
      { status: 'queued' },
      {
        $set: {
          status: 'processing',
          stage: 'Initializing',
          startedAt: new Date()
        }
      },
      { sort: { createdAt: 1 }, new: true }
    );

    if (!job) {
      return false;
    }

    this.activeWorkers++;
    this.executeJob(job)
      .catch((err) => {
        console.error(`[Queue Error] Job ${job._id} failed:`, err);
      })
      .finally(() => {
        this.activeWorkers--;
        // Check for next job
        setImmediate(() => this.triggerQueue());
      });

    return true;
  }

  /**
   * Executes a single merge job with full tracking.
   */
  async executeJob(job) {
    const abortController = new AbortController();
    this.abortControllers.set(job._id.toString(), abortController);

    if (!this.batchAbortControllers.has(job.batchId)) {
      this.batchAbortControllers.set(job.batchId, new Set());
    }
    this.batchAbortControllers.get(job.batchId).add(job._id.toString());

    this.emit('job_updated', {
      batchId: job.batchId,
      jobId: job._id.toString(),
      seriesId: job.seriesId,
      status: job.status,
      progress: job.progress || 5,
      stage: job.stage || 'Initializing'
    });

    try {
      // Fetch input files in the exact order requested
      const inputFiles = await VideoFile.find({ _id: { $in: job.inputFileIds } });
      // Map to preserve order of job.inputFileIds
      const fileMap = new Map(inputFiles.map(f => [f._id.toString(), f]));
      const orderedFiles = job.inputFileIds
        .map(id => fileMap.get(id.toString()))
        .filter(Boolean);

      if (orderedFiles.length === 0) {
        throw new Error('Input files not found on server.');
      }

      // Check available disk space on the temporary drive before processing
      try {
        const diskStats = await fs.promises.statfs(config.tempDir);
        const freeBytes = diskStats.bavail * diskStats.bsize;
        const totalInputBytes = orderedFiles.reduce((acc, f) => acc + (f.fileSize || 0), 0);
        const requiredBytes = Math.max(config.minFreeDiskSpaceMB * 1024 * 1024, totalInputBytes * 1.3);
        if (freeBytes < requiredBytes) {
          throw new Error(
            `Insufficient disk space on temp drive. Available: ${(freeBytes / (1024 * 1024)).toFixed(0)} MB, Required: ${(requiredBytes / (1024 * 1024)).toFixed(0)} MB.`
          );
        }
      } catch (diskErr) {
        if (diskErr.message.includes('Insufficient disk space')) {
          throw diskErr;
        }
      }

      const batchTempDir = path.join(config.tempDir, job.batchId);

      const result = await mergeVideoSeries({
        files: orderedFiles,
        outputPath: job.outputFilePath,
        tempDir: batchTempDir,
        abortSignal: abortController.signal,
        onProgress: async (progressPercent, stage) => {
          job.progress = progressPercent;
          job.stage = stage;
          // Update DB throttle or periodic
          await MergeJob.updateOne(
            { _id: job._id },
            { $set: { progress: progressPercent, stage } }
          );

          this.emit('job_updated', {
            batchId: job.batchId,
            jobId: job._id.toString(),
            seriesId: job.seriesId,
            status: 'processing',
            progress: progressPercent,
            stage
          });
        }
      });

      const completedAt = new Date();
      const startTime = job.startedAt || new Date();
      const elapsedSeconds = Math.max(0, Math.round((completedAt.getTime() - startTime.getTime()) / 1000));
      const completedWithinTarget = elapsedSeconds <= config.fiveMinuteTargetSeconds;

      job.status = 'completed';
      job.progress = 100;
      job.stage = 'Completed';
      job.completedAt = completedAt;
      job.elapsedSeconds = elapsedSeconds;
      job.completedWithinTarget = completedWithinTarget;
      job.outputFileSize = result.fileSize;
      job.outputDuration = result.duration;
      job.isTranscoded = result.isTranscoded;
      job.transcodeReason = result.transcodeReason || null;
      await job.save();

      this.emit('job_updated', {
        batchId: job.batchId,
        jobId: job._id.toString(),
        seriesId: job.seriesId,
        status: 'completed',
        progress: 100,
        stage: 'Completed',
        isTranscoded: job.isTranscoded,
        transcodeReason: job.transcodeReason,
        elapsedSeconds: job.elapsedSeconds,
        completedWithinTarget: job.completedWithinTarget,
        outputFileName: job.outputFileName,
        outputFileSize: job.outputFileSize,
        outputDuration: job.outputDuration
      });

    } catch (err) {
      // Clean up partial output file on failure to avoid leaving corrupt data on disk
      try {
        if (job.outputFilePath && fs.existsSync(job.outputFilePath)) {
          await fs.promises.unlink(job.outputFilePath);
        }
      } catch (_) {}

      const isCancelled = abortController.signal.aborted;
      job.status = isCancelled ? 'cancelled' : 'failed';
      job.errorMessage = err.message;
      job.stage = isCancelled ? 'Cancelled by user' : 'Failed';
      await job.save();

      this.emit('job_updated', {
        batchId: job.batchId,
        jobId: job._id.toString(),
        seriesId: job.seriesId,
        status: job.status,
        errorMessage: job.errorMessage,
        stage: job.stage
      });
    } finally {
      this.abortControllers.delete(job._id.toString());
      const batchSet = this.batchAbortControllers.get(job.batchId);
      if (batchSet) {
        batchSet.delete(job._id.toString());
      }

      // Check if all jobs in this batch are finished
      await this.checkBatchCompletion(job.batchId);
    }
  }

  /**
   * Cancels a running batch and all its active or queued jobs.
   */
  async cancelBatch(batchId) {
    const jobIds = this.batchAbortControllers.get(batchId);
    if (jobIds) {
      for (const jobId of jobIds) {
        const controller = this.abortControllers.get(jobId);
        if (controller) {
          controller.abort();
        }
      }
    }

    // Cancel queued jobs in database
    await MergeJob.updateMany(
      { batchId, status: { $in: ['queued', 'processing'] } },
      { $set: { status: 'cancelled', stage: 'Cancelled by user' } }
    );

    const batch = await Batch.findOne({ batchId });
    if (batch) {
      batch.status = 'failed';
      batch.errorMessage = 'Batch was cancelled by user.';
      await batch.save();
    }

    this.emit('batch_updated', { batchId, status: 'cancelled' });
  }

  /**
   * Checks whether all jobs for a batch have resolved (completed, failed, or cancelled).
   * When all requested outputs are ready, records outputReadyAt and sets expiresAt to strictly 10 minutes later.
   */
  async checkBatchCompletion(batchId) {
    const remainingCount = await MergeJob.countDocuments({
      batchId,
      status: { $in: ['queued', 'processing'] }
    });

    if (remainingCount === 0) {
      const totalJobs = await MergeJob.countDocuments({ batchId });
      const completedJobs = await MergeJob.countDocuments({ batchId, status: 'completed' });
      const batch = await Batch.findOne({ batchId });

      if (batch && batch.status !== 'completed' && batch.status !== 'expired') {
        const now = new Date();
        batch.outputReadyAt = now;
        if (batch.mergeStartedAt) {
          batch.elapsedSeconds = Math.max(0, Math.round((now.getTime() - batch.mergeStartedAt.getTime()) / 1000));
          batch.completedWithinTarget = batch.elapsedSeconds <= config.fiveMinuteTargetSeconds;
        }
        // Strictly 10 minutes from outputReadyAt
        batch.expiresAt = new Date(now.getTime() + config.fileRetentionMinutes * 60 * 1000);

        if (completedJobs > 0) {
          batch.status = 'completed';
        } else {
          batch.status = 'failed';
          batch.errorMessage = 'All merge jobs in this batch failed or were cancelled.';
        }

        await batch.save();

        console.log(`[Batch Finished] Batch ${batchId} outputs ready. Expires at: ${batch.expiresAt.toISOString()}`);

        this.emit('batch_completed', {
          batchId,
          status: batch.status,
          outputReadyAt: batch.outputReadyAt,
          expiresAt: batch.expiresAt,
          elapsedSeconds: batch.elapsedSeconds,
          completedWithinTarget: batch.completedWithinTarget,
          totalJobs,
          completedJobs
        });
      }
    }
  }
}

export const mergeQueueService = new MergeQueueService();

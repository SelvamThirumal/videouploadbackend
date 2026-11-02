import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import archiver from 'archiver';
import { Batch } from '../models/Batch.js';
import { VideoFile } from '../models/VideoFile.js';
import { MergeJob } from '../models/MergeJob.js';
import { parseVideoFilename, groupVideoFiles } from '../utils/parseVideoFilename.js';
import { probeVideo } from '../services/ffmpegService.js';
import { mergeQueueService } from '../services/mergeQueueService.js';
import { cleanupService } from '../services/cleanupService.js';
import { config } from '../config/env.js';

/**
 * POST /api/batches
 * Receives uploaded files, parses filenames, stores VideoFile records, creates/updates Batch.
 */
export async function uploadBatch(req, res) {
  try {
    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'No video files were uploaded.' });
    }

    const batchId = req.batchId || req.body.batchId || crypto.randomUUID();
    const token = crypto.randomBytes(16).toString('hex');

    // Parse relative paths if provided as JSON string in req.body.relativePaths
    let relativePathsMap = {};
    if (req.body.relativePaths) {
      try {
        relativePathsMap = typeof req.body.relativePaths === 'string'
          ? JSON.parse(req.body.relativePaths)
          : req.body.relativePaths;
      } catch (_) {}
    }

    let batch = await Batch.findOne({ batchId });
    if (!batch) {
      batch = new Batch({
        batchId,
        token,
        status: 'uploading',
        totalFiles: 0,
        totalSize: 0
      });
    }

    let totalUploadedSize = 0;
    // 1. Probe all uploaded files in parallel for instant responsiveness
    const probedResults = await Promise.all(
      files.map(async (file) => {
        try {
          return await probeVideo(file.path);
        } catch (_) {
          return null;
        }
      })
    );

    const createdFileDocs = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const probed = probedResults[i];
      totalUploadedSize += file.size;

      // Extract original relative path if available from map
      const originalName = file.originalname;
      const relativePath = relativePathsMap[originalName] || file.originalname;

      // Parse series & part number
      const parsed = parseVideoFilename(originalName);

      const videoDocData = {
        batchId,
        originalName,
        relativePath,
        seriesId: parsed.seriesId,
        partNumber: parsed.partNumber,
        filePath: file.path,
        fileSize: file.size,
        status: probed ? 'analyzed' : 'uploaded',
        duration: probed?.duration || 0,
        videoCodec: probed?.videoCodec || 'unknown',
        audioCodec: probed?.audioCodec || 'none',
        width: probed?.width || 0,
        height: probed?.height || 0,
        fps: probed?.fps || 30
      };

      createdFileDocs.push(videoDocData);
    }

    if (createdFileDocs.length > 0) {
      await VideoFile.insertMany(createdFileDocs);
    }

    // Update batch totals
    batch.totalFiles = await VideoFile.countDocuments({ batchId });
    const allFiles = await VideoFile.find({ batchId }).lean();
    const combinedSize = allFiles.reduce((acc, f) => acc + (f.fileSize || 0), 0);
    batch.totalSize = combinedSize;

    // Check configured batch size limit (e.g. 1 TB)
    const maxBytes = config.maxBatchSizeMB * 1024 * 1024;
    if (batch.totalSize > maxBytes) {
      // Clean up files and return error
      await cleanupService.cleanBatch(batchId);
      const limitLabel = config.maxBatchSizeMB >= 1048576
        ? `${(config.maxBatchSizeMB / 1048576).toFixed(0)} TB`
        : config.maxBatchSizeMB >= 1024
        ? `${(config.maxBatchSizeMB / 1024).toFixed(0)} GB`
        : `${config.maxBatchSizeMB} MB`;

      return res.status(400).json({
        error: `Total batch size exceeds the configured limit of ${limitLabel}. Current total: ${(batch.totalSize / (1024 * 1024 * 1024)).toFixed(2)} GB.`
      });
    }

    batch.status = 'ready';
    batch.uploadCompletedAt = new Date();
    await batch.save();

    // Group files for response
    const grouped = groupVideoFiles(allFiles);

    return res.status(201).json({
      batchId: batch.batchId,
      token: batch.token,
      status: batch.status,
      totalFiles: batch.totalFiles,
      totalSize: batch.totalSize,
      groups: grouped.groups,
      unrecognized: grouped.unrecognized,
      summary: grouped.summary
    });
  } catch (error) {
    console.error('[Upload Error]', error);
    return res.status(500).json({ error: error.message || 'File upload failed.' });
  }
}

/**
 * GET /api/batches/:batchId
 */
export async function getBatch(req, res) {
  try {
    const { batchId } = req.params;
    const batch = await Batch.findOne({ batchId });
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found.' });
    }

    const isExpired = batch.status === 'expired' || (batch.expiresAt && new Date() >= new Date(batch.expiresAt));

    return res.json({
      batchId: batch.batchId,
      status: isExpired ? 'expired' : batch.status,
      totalFiles: batch.totalFiles,
      totalSize: batch.totalSize,
      createdAt: batch.createdAt,
      uploadCompletedAt: batch.uploadCompletedAt,
      outputReadyAt: batch.outputReadyAt,
      expiresAt: batch.expiresAt,
      isExpired,
      errorMessage: batch.errorMessage
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/batches/:batchId/files
 */
export async function getBatchFiles(req, res) {
  try {
    const { batchId } = req.params;
    const files = await VideoFile.find({ batchId }).sort({ seriesId: 1, partNumber: 1 }).lean();
    return res.json({ files });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/batches/:batchId/groups
 */
export async function getBatchGroups(req, res) {
  try {
    const { batchId } = req.params;
    const files = await VideoFile.find({ batchId }).lean();
    if (files.length === 0) {
      return res.status(404).json({ error: 'No files found for this batch.' });
    }

    const grouped = groupVideoFiles(files);
    return res.json(grouped);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

/**
 * PUT /api/batches/:batchId/groups
 * Saves user corrections and manual ordering.
 * Expects body: { groups: [{ seriesId: string, parts: [{ id: string, partNumber: number, seriesId?: string }] }] }
 */
export async function updateBatchGroups(req, res) {
  try {
    const { batchId } = req.params;
    const { groups, unrecognized } = req.body;

    if (!Array.isArray(groups)) {
      return res.status(400).json({ error: 'Invalid groups format. Expected an array of groups.' });
    }

    // Update each file in DB
    for (const group of groups) {
      const targetSeriesId = String(group.seriesId || '').trim();
      if (!targetSeriesId) continue;

      if (Array.isArray(group.parts)) {
        for (let i = 0; i < group.parts.length; i++) {
          const part = group.parts[i];
          const fileId = part.id || part._id;
          const partNum = Number(part.partNumber) || (i + 1);

          await VideoFile.updateOne(
            { _id: fileId, batchId },
            { $set: { seriesId: targetSeriesId, partNumber: partNum } }
          );
        }
      }
    }

    // If any unrecognized files were manually assigned
    if (Array.isArray(unrecognized)) {
      for (const item of unrecognized) {
        if (item.seriesId && item.seriesId !== 'Unrecognized') {
          const fileId = item.id || item._id;
          await VideoFile.updateOne(
            { _id: fileId, batchId },
            { $set: { seriesId: String(item.seriesId).trim(), partNumber: Number(item.partNumber) || 1 } }
          );
        }
      }
    }

    // Re-query and re-group to validate
    const updatedFiles = await VideoFile.find({ batchId });
    const regrouped = groupVideoFiles(updatedFiles);

    return res.json(regrouped);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/batches/:batchId/merge
 * Enqueues merge jobs for all series groups.
 */
export async function startBatchMerge(req, res) {
  try {
    const { batchId } = req.params;
    const batch = await Batch.findOne({ batchId });
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found.' });
    }

    if (batch.status === 'expired') {
      return res.status(410).json({ error: 'This batch has expired and its files have been cleaned up.' });
    }

    // Get current files and groups
    const files = await VideoFile.find({ batchId });
    if (files.length === 0) {
      return res.status(400).json({ error: 'No files available to merge.' });
    }

    // Client may optionally pass custom series configuration or fallback to server grouped files
    let seriesConfigs = [];
    if (req.body.seriesConfigs && Array.isArray(req.body.seriesConfigs)) {
      seriesConfigs = req.body.seriesConfigs;
    } else {
      const grouped = groupVideoFiles(files);
      seriesConfigs = grouped.groups.map(g => ({
        seriesId: g.seriesId,
        partFileIds: g.parts.map(p => p._id.toString())
      }));
    }

    // Record merge start timestamp
    batch.status = 'processing';
    batch.mergeStartedAt = new Date();
    await batch.save();

    // Enqueue jobs in background queue
    const jobs = await mergeQueueService.enqueueBatch(batchId, seriesConfigs);

    return res.json({
      message: `Enqueued ${jobs.length} series merge jobs successfully.`,
      batchId,
      jobCount: jobs.length,
      jobs: jobs.map(j => ({
        jobId: j._id,
        seriesId: j.seriesId,
        status: j.status,
        progress: j.progress
      }))
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/batches/:batchId/progress
 * Supports both JSON polling and Server-Sent Events (SSE).
 */
export async function getBatchProgress(req, res) {
  try {
    const { batchId } = req.params;
    const isSSE = req.headers.accept && req.headers.accept.includes('text/event-stream');

    if (isSSE) {
      // Server-Sent Events implementation
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      const sendEvent = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      // Initial state
      const batch = await Batch.findOne({ batchId });
      const jobs = await MergeJob.find({ batchId });
      sendEvent('state', { batch, jobs });

      const onJobUpdated = (payload) => {
        if (payload.batchId === batchId) {
          sendEvent('job_updated', payload);
        }
      };

      const onBatchCompleted = (payload) => {
        if (payload.batchId === batchId) {
          sendEvent('batch_completed', payload);
        }
      };

      mergeQueueService.on('job_updated', onJobUpdated);
      mergeQueueService.on('batch_completed', onBatchCompleted);

      req.on('close', () => {
        mergeQueueService.off('job_updated', onJobUpdated);
        mergeQueueService.off('batch_completed', onBatchCompleted);
      });

      return;
    }

    // Polling JSON fallback
    const batch = await Batch.findOne({ batchId });
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found.' });
    }

    const jobs = await MergeJob.find({ batchId });
    const totalJobs = jobs.length;
    const completedJobs = jobs.filter(j => j.status === 'completed').length;
    const failedJobs = jobs.filter(j => j.status === 'failed').length;

    let overallProgress = 0;
    if (totalJobs > 0) {
      const sumProgress = jobs.reduce((acc, j) => acc + (j.progress || 0), 0);
      overallProgress = Math.round(sumProgress / totalJobs);
    }

    const now = Date.now();
    let batchElapsedSeconds = batch.elapsedSeconds || 0;
    if (batch.status === 'processing' && batch.mergeStartedAt) {
      batchElapsedSeconds = Math.max(0, Math.round((now - new Date(batch.mergeStartedAt).getTime()) / 1000));
    }

    return res.json({
      batchId,
      status: batch.status,
      overallProgress,
      totalJobs,
      completedJobs,
      failedJobs,
      mergeStartedAt: batch.mergeStartedAt,
      elapsedSeconds: batchElapsedSeconds,
      completedWithinTarget: batch.completedWithinTarget,
      targetSeconds: config.fiveMinuteTargetSeconds,
      expiresAt: batch.expiresAt,
      outputReadyAt: batch.outputReadyAt,
      jobs: jobs.map(j => {
        const jElapsed = j.elapsedSeconds || (j.startedAt && j.status === 'processing'
          ? Math.max(0, Math.round((now - new Date(j.startedAt).getTime()) / 1000))
          : 0);

        let estimatedRemainingSeconds = null;
        if (j.status === 'processing' && j.progress > 5 && jElapsed > 0) {
          const rate = j.progress / jElapsed;
          const remainingPercent = Math.max(0, 100 - j.progress);
          estimatedRemainingSeconds = Math.max(0, Math.round(remainingPercent / rate));
        }

        return {
          jobId: j._id,
          seriesId: j.seriesId,
          status: j.status,
          progress: j.progress,
          stage: j.stage,
          isTranscoded: j.isTranscoded,
          transcodeReason: j.transcodeReason,
          startedAt: j.startedAt,
          completedAt: j.completedAt,
          elapsedSeconds: jElapsed,
          estimatedRemainingSeconds,
          completedWithinTarget: j.completedWithinTarget,
          outputFileName: j.outputFileName,
          outputFileSize: j.outputFileSize,
          outputDuration: j.outputDuration,
          errorMessage: j.errorMessage
        };
      })
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/batches/:batchId/results
 * Returns ready downloadable video cards with expiration and performance info.
 */
export async function getBatchResults(req, res) {
  try {
    const { batchId } = req.params;
    const batch = await Batch.findOne({ batchId });
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found.' });
    }

    const isExpired = batch.status === 'expired' || (batch.expiresAt && new Date() >= new Date(batch.expiresAt));

    const jobs = await MergeJob.find({ batchId });

    return res.json({
      batchId,
      status: isExpired ? 'expired' : batch.status,
      isExpired,
      outputReadyAt: batch.outputReadyAt,
      mergeStartedAt: batch.mergeStartedAt,
      elapsedSeconds: batch.elapsedSeconds,
      completedWithinTarget: batch.completedWithinTarget,
      targetSeconds: config.fiveMinuteTargetSeconds,
      expiresAt: batch.expiresAt,
      serverTime: new Date(),
      results: jobs.map(j => ({
        jobId: j._id,
        seriesId: j.seriesId,
        outputFileName: j.outputFileName,
        fileSize: j.outputFileSize,
        duration: j.outputDuration,
        status: j.status,
        isTranscoded: j.isTranscoded,
        transcodeReason: j.transcodeReason,
        elapsedSeconds: j.elapsedSeconds,
        completedWithinTarget: j.completedWithinTarget,
        errorMessage: j.errorMessage,
        downloadUrl: `/api/batches/${batchId}/download/${j._id}`
      }))
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/batches/:batchId/download/:jobId
 * Securely streams an individual output file with lease protection.
 */
export async function downloadOutputFile(req, res) {
  const { batchId, jobId } = req.params;

  try {
    const batch = await Batch.findOne({ batchId });
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found.' });
    }

    // Check expiration: reject new downloads if batch is expired
    if (batch.status === 'expired' || (batch.expiresAt && new Date() >= new Date(batch.expiresAt))) {
      return res.status(410).json({
        error: 'This batch has expired (10-minute limit exceeded). Files have been securely deleted.'
      });
    }

    const job = await MergeJob.findOne({ _id: jobId, batchId });
    if (!job || !job.outputFilePath || !fs.existsSync(job.outputFilePath)) {
      return res.status(404).json({ error: 'Merged video output file not found or not yet ready.' });
    }

    // Acquire download lease to prevent cleanup from deleting file while stream is active
    cleanupService.acquireDownloadLease(batchId);

    const stat = await fs.promises.stat(job.outputFilePath);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(job.outputFileName)}"`);

    const fileStream = fs.createReadStream(job.outputFilePath);

    const release = () => cleanupService.releaseDownloadLease(batchId);
    fileStream.on('end', release);
    fileStream.on('error', release);
    res.on('close', release);

    fileStream.pipe(res);
  } catch (err) {
    cleanupService.releaseDownloadLease(batchId);
    console.error('[Download Error]', err);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/batches/:batchId/download-all
 * Streams a ZIP file containing all completed series outputs in this batch.
 */
export async function downloadAllZip(req, res) {
  const { batchId } = req.params;

  try {
    const batch = await Batch.findOne({ batchId });
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found.' });
    }

    if (batch.status === 'expired' || (batch.expiresAt && new Date() >= new Date(batch.expiresAt))) {
      return res.status(410).json({
        error: 'This batch has expired (10-minute limit exceeded). Files have been securely deleted.'
      });
    }

    const completedJobs = await MergeJob.find({ batchId, status: 'completed' });
    if (completedJobs.length === 0) {
      return res.status(400).json({ error: 'No completed video files are available to zip.' });
    }

    cleanupService.acquireDownloadLease(batchId);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="FASTBATCH_${batchId.substring(0, 8)}.zip"`);

    const archive = archiver('zip', { zlib: { level: 1 } }); // Low compression level for max speed with video

    const release = () => cleanupService.releaseDownloadLease(batchId);
    archive.on('end', release);
    archive.on('error', (err) => {
      release();
      console.error('[ZIP Error]', err);
    });
    res.on('close', release);

    archive.pipe(res);

    for (const job of completedJobs) {
      if (job.outputFilePath && fs.existsSync(job.outputFilePath)) {
        archive.file(job.outputFilePath, { name: job.outputFileName });
      }
    }

    await archive.finalize();
  } catch (err) {
    cleanupService.releaseDownloadLease(batchId);
    console.error('[ZIP Download Error]', err);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * DELETE /api/batches/:batchId
 * Cancels running merge jobs and immediately cleans up batch files.
 */
export async function deleteBatch(req, res) {
  try {
    const { batchId } = req.params;
    await mergeQueueService.cancelBatch(batchId);
    await cleanupService.cleanBatch(batchId);
    return res.json({ message: `Batch ${batchId} cancelled and cleaned up successfully.` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

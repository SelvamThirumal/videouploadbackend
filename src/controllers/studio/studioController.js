import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../../config/env.js';
import { removeAudioNoise } from '../../services/studio/audioNoiseService.js';
import { mixAudioTracks, extractAudioFromVideo } from '../../services/studio/audioStudioService.js';
import { exportStudioVideo } from '../../services/studio/videoExportService.js';
import { registerDownload, scheduleDirectoryCleanup } from '../tools/toolsController.js';

/**
 * 1. AI Background Noise Remover Endpoint
 * Handles Audio & Video files with speech enhancement
 */
export async function handleNoiseRemoval(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload an audio or video file.' });
    }

    const { mode, customNoiseFloor, customVoiceBoost, highpassFreq, lowpassFreq } = req.body;
    const sessionId = `noise_${crypto.randomUUID()}`;
    const outputDir = path.join(config.tempDir, 'studio', sessionId);
    await fs.promises.mkdir(outputDir, { recursive: true });
    scheduleDirectoryCleanup(outputDir);

    const result = await removeAudioNoise({
      filePath: req.file.path,
      outputDir,
      mode: mode || 'medium',
      customNoiseFloor,
      customVoiceBoost: customVoiceBoost === 'true' || customVoiceBoost === true,
      highpassFreq,
      lowpassFreq
    });

    const download = registerDownload(result.filePath, result.fileName);

    return res.json({
      success: true,
      sessionId,
      ...result,
      download
    });
  } catch (err) {
    console.error('[AI Noise Remover Error]', err);
    return res.status(500).json({ error: err.message || 'Noise reduction failed.' });
  }
}

/**
 * 2. Audio Studio: Mix Multiple Audio Tracks
 */
export async function handleMixAudio(req, res) {
  try {
    const files = req.files || (req.file ? [req.file] : []);
    if (files.length === 0) {
      return res.status(400).json({ error: 'Please upload at least one audio track.' });
    }

    const sessionId = `audio_studio_${crypto.randomUUID()}`;
    const outputDir = path.join(config.tempDir, 'studio', sessionId);
    await fs.promises.mkdir(outputDir, { recursive: true });
    scheduleDirectoryCleanup(outputDir);

    let tracksConfig = [];
    if (req.body.tracksJson) {
      try {
        tracksConfig = JSON.parse(req.body.tracksJson);
      } catch (_) {}
    }

    const mappedTracks = files.map((f, idx) => {
      const cfg = tracksConfig[idx] || {};
      return {
        filePath: f.path,
        startTime: cfg.startTime || 0,
        volume: cfg.volume !== undefined ? cfg.volume : 1,
        fadeIn: cfg.fadeIn || 0,
        fadeOut: cfg.fadeOut || 0,
        speed: cfg.speed || 1,
        duration: cfg.duration || null
      };
    });

    const result = await mixAudioTracks({
      tracks: mappedTracks,
      outputDir,
      outputFormat: req.body.outputFormat || 'mp3'
    });

    const download = registerDownload(result.filePath, result.fileName);

    return res.json({
      success: true,
      sessionId,
      ...result,
      download
    });
  } catch (err) {
    console.error('[Audio Studio Mix Error]', err);
    return res.status(500).json({ error: err.message || 'Audio mixing failed.' });
  }
}

/**
 * 3. Audio Studio: Extract Audio from Video
 */
export async function handleExtractAudio(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload a video file.' });
    }

    const sessionId = `audio_ext_${crypto.randomUUID()}`;
    const outputDir = path.join(config.tempDir, 'studio', sessionId);
    await fs.promises.mkdir(outputDir, { recursive: true });
    scheduleDirectoryCleanup(outputDir);

    const result = await extractAudioFromVideo({
      filePath: req.file.path,
      outputDir,
      format: req.body.format || 'mp3'
    });

    const download = registerDownload(result.filePath, result.fileName);

    return res.json({
      success: true,
      sessionId,
      ...result,
      download
    });
  } catch (err) {
    console.error('[Extract Audio Error]', err);
    return res.status(500).json({ error: err.message || 'Audio extraction failed.' });
  }
}

/**
 * 4. Video Editor Export Studio Endpoint
 */
export async function handleExportVideo(req, res) {
  try {
    const files = req.files || (req.file ? [req.file] : []);
    if (files.length === 0) {
      return res.status(400).json({ error: 'Please upload at least one video or media file for export.' });
    }

    const sessionId = `export_${crypto.randomUUID()}`;
    const outputDir = path.join(config.tempDir, 'studio', sessionId);
    await fs.promises.mkdir(outputDir, { recursive: true });
    scheduleDirectoryCleanup(outputDir);

    let timelineData = {};
    if (req.body.timelineJson) {
      try {
        timelineData = JSON.parse(req.body.timelineJson);
      } catch (_) {}
    }

    // Map uploaded files to timeline video clips
    const videoClips = files.map((f, idx) => {
      const clipCfg = (timelineData.videoClips && timelineData.videoClips[idx]) || {};
      return {
        filePath: f.path,
        trimStart: clipCfg.trimStart || 0,
        duration: clipCfg.duration || null,
        speed: clipCfg.speed || 1
      };
    });

    const result = await exportStudioVideo({
      timeline: {
        ...timelineData,
        videoClips
      },
      outputDir,
      resolution: req.body.resolution || '1080p',
      aspectRatio: req.body.aspectRatio || '16:9',
      fps: req.body.fps || 30,
      format: req.body.format || 'mp4',
      videoBitrate: req.body.videoBitrate || '8M',
      audioBitrate: req.body.audioBitrate || '192k'
    });

    const download = registerDownload(result.filePath, result.fileName);

    return res.json({
      success: true,
      sessionId,
      ...result,
      download
    });
  } catch (err) {
    console.error('[Studio Export Error]', err);
    return res.status(500).json({ error: err.message || 'Video export failed.' });
  }
}

/**
 * 5. Immediate "Clear Files" Endpoint for Privacy Purge
 */
export async function handleClearSession(req, res) {
  try {
    const { sessionId } = req.params;
    if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      return res.status(400).json({ error: 'Invalid session identifier.' });
    }

    const sessionDir = path.join(config.tempDir, 'studio', sessionId);
    if (fs.existsSync(sessionDir)) {
      await fs.promises.rm(sessionDir, { recursive: true, force: true });
    }

    return res.json({ success: true, message: 'All temporary session files permanently purged immediately.' });
  } catch (err) {
    console.error('[Clear Session Error]', err);
    return res.status(500).json({ error: 'Failed to purge session files.' });
  }
}

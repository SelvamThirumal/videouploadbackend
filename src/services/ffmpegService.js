import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { config } from '../config/env.js';

/**
 * Executes a command and captures stdout/stderr JSON or text safely.
 */
function execAsync(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { windowsHide: true, ...options });
    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to execute ${cmd}: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Process ${cmd} exited with code ${code}. Stderr: ${stderr.slice(-500)}`));
      }
    });

    if (options.abortSignal) {
      options.abortSignal.addEventListener('abort', () => {
        try {
          proc.kill('SIGTERM');
        } catch (_) {}
      });
    }
  });
}

/**
 * Inspects a video file using ffprobe.
 * @param {string} filePath 
 * @returns {Promise<{
 *   duration: number,
 *   width: number,
 *   height: number,
 *   videoCodec: string,
 *   audioCodec: string,
 *   audioSampleRate: number,
 *   audioChannels: number,
 *   fps: number,
 *   pixFmt: string,
 *   hasAudio: boolean,
 *   fileSize: number
 * }>}
 */
export async function probeVideo(filePath) {
  const stat = await fs.promises.stat(filePath);
  const args = [
    '-v', 'error',
    '-show_entries', 'stream=codec_name,codec_type,width,height,r_frame_rate,pix_fmt,sample_rate,channels',
    '-show_entries', 'format=duration,size',
    '-of', 'json',
    filePath
  ];

  try {
    const { stdout } = await execAsync(config.ffprobePath, args);
    const data = JSON.parse(stdout);

    const streams = data.streams || [];
    const format = data.format || {};

    const videoStream = streams.find(s => s.codec_type === 'video');
    const audioStream = streams.find(s => s.codec_type === 'audio');

    let fps = 0;
    if (videoStream?.r_frame_rate) {
      const parts = videoStream.r_frame_rate.split('/');
      if (parts.length === 2 && Number(parts[1]) > 0) {
        fps = Math.round(Number(parts[0]) / Number(parts[1]));
      } else {
        fps = Number(videoStream.r_frame_rate) || 0;
      }
    }

    const duration = parseFloat(format.duration || '0') || 0;
    const audioSampleRate = parseInt(audioStream?.sample_rate || '0', 10) || 0;
    const audioChannels = parseInt(audioStream?.channels || '0', 10) || 0;

    return {
      duration,
      width: videoStream?.width || 0,
      height: videoStream?.height || 0,
      videoCodec: videoStream?.codec_name || 'unknown',
      audioCodec: audioStream?.codec_name || 'none',
      audioSampleRate,
      audioChannels,
      fps: fps || 30,
      pixFmt: videoStream?.pix_fmt || 'yuv420p',
      hasAudio: !!audioStream,
      fileSize: stat.size
    };
  } catch (err) {
    console.warn(`[FFprobe Warning] Could not probe ${filePath}: ${err.message}`);
    return {
      duration: 0,
      width: 0,
      height: 0,
      videoCodec: 'unknown',
      audioCodec: 'none',
      audioSampleRate: 0,
      audioChannels: 0,
      fps: 30,
      pixFmt: 'yuv420p',
      hasAudio: false,
      fileSize: stat.size
    };
  }
}

/**
 * Helper normalizers to avoid false negatives when comparing codecs and pixel formats.
 */
function normalizeVideoCodec(codec) {
  if (!codec) return 'unknown';
  const c = codec.toLowerCase().trim();
  if (c === 'avc1' || c === 'h264') return 'h264';
  if (c === 'hev1' || c === 'hvc1' || c === 'hevc') return 'hevc';
  return c;
}

function normalizeAudioCodec(codec) {
  if (!codec) return 'none';
  const c = codec.toLowerCase().trim();
  if (c.includes('mp4a') || c.includes('aac')) return 'aac';
  return c;
}

function normalizePixFmt(pixFmt) {
  if (!pixFmt) return 'yuv420p';
  const p = pixFmt.toLowerCase().trim();
  if (p === 'yuvj420p') return 'yuv420p';
  return p;
}

/**
 * Checks whether all parts in a series have compatible stream parameters
 * so we can use lossless fast concat copy (-c copy).
 * Returns { compatible: boolean, reason?: string }.
 */
export function checkConcatCompatibility(probedList) {
  if (probedList.length <= 1) return { compatible: true };

  const first = probedList[0];
  const firstVCodec = normalizeVideoCodec(first.videoCodec);
  const firstACodec = normalizeAudioCodec(first.audioCodec);
  const firstPix = normalizePixFmt(first.pixFmt);

  for (let i = 1; i < probedList.length; i++) {
    const cur = probedList[i];
    const curVCodec = normalizeVideoCodec(cur.videoCodec);
    const curACodec = normalizeAudioCodec(cur.audioCodec);
    const curPix = normalizePixFmt(cur.pixFmt);

    if (curVCodec !== firstVCodec || curVCodec === 'unknown') {
      return {
        compatible: false,
        reason: `Video codec mismatch across parts (${first.videoCodec} vs ${cur.videoCodec})`
      };
    }
    if (cur.width !== first.width || cur.height !== first.height) {
      return {
        compatible: false,
        reason: `Resolution mismatch across parts (${first.width}x${first.height} vs ${cur.width}x${cur.height})`
      };
    }
    if (curPix !== firstPix) {
      return {
        compatible: false,
        reason: `Pixel format mismatch across parts (${first.pixFmt} vs ${cur.pixFmt})`
      };
    }
    if (cur.hasAudio !== first.hasAudio) {
      return {
        compatible: false,
        reason: 'Audio stream layout difference (some clips have audio, others are silent)'
      };
    }
    if (first.hasAudio) {
      if (curACodec !== firstACodec) {
        return {
          compatible: false,
          reason: `Audio codec mismatch across parts (${first.audioCodec} vs ${cur.audioCodec})`
        };
      }
      if (first.audioSampleRate && cur.audioSampleRate && first.audioSampleRate !== cur.audioSampleRate) {
        return {
          compatible: false,
          reason: `Audio sample rate mismatch (${first.audioSampleRate}Hz vs ${cur.audioSampleRate}Hz)`
        };
      }
      if (first.audioChannels && cur.audioChannels && first.audioChannels !== cur.audioChannels) {
        return {
          compatible: false,
          reason: `Audio channel mismatch (${first.audioChannels}ch vs ${cur.audioChannels}ch)`
        };
      }
    }
    if (first.fps && cur.fps && Math.abs(first.fps - cur.fps) > 2) {
      return {
        compatible: false,
        reason: `Frame rate mismatch (${first.fps}fps vs ${cur.fps}fps)`
      };
    }
  }

  return { compatible: true };
}

/**
 * Backward-compatible helper for boolean concat capability.
 */
export function canFastConcat(probedList) {
  return checkConcatCompatibility(probedList).compatible;
}

/**
 * Parse FFmpeg stderr time output (e.g. time=00:01:23.45) into seconds.
 */
function parseTimeInSeconds(timeStr) {
  const parts = timeStr.trim().split(':');
  if (parts.length === 3) {
    const hours = parseFloat(parts[0]) || 0;
    const mins = parseFloat(parts[1]) || 0;
    const secs = parseFloat(parts[2]) || 0;
    return hours * 3600 + mins * 60 + secs;
  }
  return 0;
}

/**
 * Verifies that the merged output file exists, is non-empty, and has a playable video stream.
 * @param {string} outputPath 
 * @returns {Promise<{ probed: Object, fileSize: number }>}
 */
export async function verifyOutputFile(outputPath) {
  if (!fs.existsSync(outputPath)) {
    throw new Error('Merged output file was not created on disk.');
  }
  const stat = await fs.promises.stat(outputPath);
  if (stat.size === 0) {
    throw new Error('Merged output file is 0 bytes (empty).');
  }
  const probed = await probeVideo(outputPath);
  if (!probed.videoCodec || probed.videoCodec === 'unknown') {
    throw new Error('Merged output file has no valid video stream.');
  }
  if (probed.duration <= 0) {
    throw new Error('Merged output file duration is 0 seconds.');
  }
  return { probed, fileSize: stat.size };
}

/**
 * Cache for dynamically detected optimal video encoder.
 */
let cachedEncoder = null;

/**
 * Dynamically detects the best working video encoder (hardware accelerated or high-speed CPU).
 */
export async function detectBestEncoder() {
  if (cachedEncoder) return cachedEncoder;

  if (config.ffmpegVideoEncoder && config.ffmpegVideoEncoder !== 'auto') {
    cachedEncoder = { name: config.ffmpegVideoEncoder, isHardware: config.ffmpegVideoEncoder !== 'libx264' };
    return cachedEncoder;
  }

  // Candidate encoders to test in order of speed priority
  const candidates = [
    { name: 'h264_nvenc', testArgs: ['-c:v', 'h264_nvenc', '-preset', 'p1', '-b:v', '3000k'], isHardware: true },
    { name: 'h264_qsv', testArgs: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-b:v', '3000k'], isHardware: true },
    { name: 'h264_amf', testArgs: ['-c:v', 'h264_amf', '-b:v', '3000k'], isHardware: true },
    { name: 'h264_videotoolbox', testArgs: ['-c:v', 'h264_videotoolbox', '-b:v', '3000k'], isHardware: true },
    { name: 'h264_mf', testArgs: ['-c:v', 'h264_mf', '-b:v', '3000k'], isHardware: true },
    { name: 'libx264', testArgs: ['-c:v', 'libx264', '-preset', 'ultrafast'], isHardware: false }
  ];

  for (const cand of candidates) {
    try {
      const testArgs = [
        '-v', 'error',
        '-f', 'lavfi',
        '-i', 'color=c=black:s=64x64:d=0.05',
        ...cand.testArgs,
        '-f', 'null',
        '-'
      ];
      await execAsync(config.ffmpegPath, testArgs);
      console.log(`[FFmpeg Engine] Selected video encoder: ${cand.name} (Hardware acceleration: ${cand.isHardware})`);
      cachedEncoder = cand;
      return cachedEncoder;
    } catch (_) {}
  }

  cachedEncoder = { name: 'libx264', isHardware: false };
  return cachedEncoder;
}

/**
 * Returns optimal encoder command-line parameters for the selected encoder.
 */
function getEncoderFlags(encoderName) {
  switch (encoderName) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'ull', '-rc', 'vbr', '-cq', '24', '-pix_fmt', 'yuv420p'];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-b:v', '3000k'];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-usage', 'ultralowlatency', '-quality', 'speed', '-pix_fmt', 'yuv420p'];
    case 'h264_videotoolbox':
      return ['-c:v', 'h264_videotoolbox', '-b:v', '3000k', '-pix_fmt', 'yuv420p'];
    case 'h264_mf':
      return ['-c:v', 'h264_mf', '-b:v', '3000k', '-pix_fmt', 'yuv420p'];
    case 'libx264':
    default:
      return ['-c:v', 'libx264', '-preset', config.ffmpegPreset || 'ultrafast', '-tune', 'fastdecode', '-crf', '23', '-pix_fmt', 'yuv420p'];
  }
}

/**
 * Merges video files using FFmpeg. Automatically chooses Fast Path (-c copy)
 * or Compatibility Transcode Path based on stream analysis.
 * If Fast Path fails for any stream timestamp reason, it automatically falls back
 * to Compatibility Transcode Path without failing the user's merge job.
 * 
 * @param {Object} options
 * @param {Array<{ filePath: string, metadata?: Object }>} options.files
 * @param {string} options.outputPath
 * @param {string} options.tempDir
 * @param {Function} [options.onProgress] (progressPercent: number, stage: string) => void
 * @param {AbortSignal} [options.abortSignal]
 * @returns {Promise<{ isTranscoded: boolean, transcodeReason?: string, duration: number, fileSize: number }>}
 */
export async function mergeVideoSeries({ files, outputPath, tempDir, onProgress, abortSignal }) {
  if (!files || files.length === 0) {
    throw new Error('No input files provided for merge.');
  }

  // 1. Probe all files
  if (onProgress) onProgress(5, 'Analyzing video streams');
  const probedList = [];
  let totalDuration = 0;

  for (let i = 0; i < files.length; i++) {
    const probed = await probeVideo(files[i].filePath);
    probedList.push(probed);
    totalDuration += probed.duration;
  }

  // Single file handling
  if (files.length === 1) {
    if (onProgress) onProgress(50, 'Finalizing single-video series');
    await fs.promises.copyFile(files[0].filePath, outputPath);
    const verified = await verifyOutputFile(outputPath);
    if (onProgress) onProgress(100, 'Completed');
    return {
      isTranscoded: false,
      duration: verified.probed.duration || probedList[0].duration,
      fileSize: verified.fileSize
    };
  }

  const compatResult = checkConcatCompatibility(probedList);

  if (compatResult.compatible) {
    try {
      // Fast path: Concat demuxer with stream copy
      return await executeFastConcat({
        files,
        outputPath,
        tempDir,
        totalDuration,
        onProgress,
        abortSignal
      });
    } catch (fastErr) {
      console.warn(`[Fast Concat Warning] Stream copy failed or output invalid (${fastErr.message}). Automatically falling back to high-speed transcode...`);
      
      // Clean up partial output if any was created
      try {
        if (fs.existsSync(outputPath)) {
          await fs.promises.unlink(outputPath);
        }
      } catch (_) {}

      if (onProgress) onProgress(15, 'Retrying with high-speed compatibility transcode');
      return await executeTranscodeConcat({
        files,
        probedList,
        outputPath,
        totalDuration,
        transcodeReason: `Stream copy timestamp fallback: ${fastErr.message}`,
        onProgress,
        abortSignal
      });
    }
  } else {
    // Compatibility path: Transcode and normalize
    return await executeTranscodeConcat({
      files,
      probedList,
      outputPath,
      totalDuration,
      transcodeReason: compatResult.reason || 'Streams have incompatible parameters',
      onProgress,
      abortSignal
    });
  }
}

/**
 * Fast path: Concat Demuxer with Stream Copy (-c copy)
 */
async function executeFastConcat({ files, outputPath, tempDir, totalDuration, onProgress, abortSignal }) {
  if (onProgress) onProgress(15, 'Preparing stream-copy manifest');

  // Create manifest file with safe escaped paths
  const manifestPath = path.join(tempDir, `manifest_${Date.now()}_${Math.random().toString(36).substring(2, 9)}.txt`);
  const manifestLines = files.map(f => {
    // Replace backslashes with forward slashes for FFmpeg manifest compatibility
    const normalized = f.filePath.replace(/\\/g, '/');
    // Escape single quotes: ' -> '\''
    const escaped = normalized.replace(/'/g, "'\\''");
    return `file '${escaped}'`;
  });

  await fs.promises.writeFile(manifestPath, manifestLines.join('\n'), 'utf8');

  try {
    if (onProgress) onProgress(25, 'Merging streams (Lossless Stream Copy)');

    const args = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', manifestPath,
      '-c', 'copy',
      '-fflags', '+genpts',
      '-avoid_negative_ts', 'make_zero',
      '-max_muxing_queue_size', '4096',
      '-movflags', '+faststart',
      outputPath
    ];

    await runFfmpegWithProgress({
      args,
      totalDuration,
      onProgress,
      abortSignal,
      baseProgress: 25,
      maxProgress: 95,
      stageName: 'Merging streams (Lossless Stream Copy)'
    });

    // Verify output integrity
    const verified = await verifyOutputFile(outputPath);
    if (onProgress) onProgress(100, 'Completed');

    return {
      isTranscoded: false,
      duration: verified.probed.duration || totalDuration,
      fileSize: verified.fileSize
    };
  } finally {
    // Clean up manifest file
    try {
      if (fs.existsSync(manifestPath)) {
        await fs.promises.unlink(manifestPath);
      }
    } catch (_) {}
  }
}

/**
 * Compatibility path: Normalizes disparate video & audio formats and merges cleanly at maximum speed.
 */
async function executeTranscodeConcat({ files, probedList, outputPath, totalDuration, transcodeReason, onProgress, abortSignal }) {
  if (onProgress) onProgress(15, 'Normalizing audio/video streams (High-Speed Transcode)');

  // Determine standard target resolution (max width and height or 1280x720)
  let targetWidth = 1280;
  let targetHeight = 720;
  let allSameDimensions = true;
  let allSameFps = true;
  const first = probedList[0] || {};

  for (const p of probedList) {
    if (p.width > targetWidth) targetWidth = p.width;
    if (p.height > targetHeight) targetHeight = p.height;
    if (p.width !== first.width || p.height !== first.height) {
      allSameDimensions = false;
    }
    if (Math.abs((p.fps || 30) - (first.fps || 30)) > 1) {
      allSameFps = false;
    }
  }

  // Ensure target dimensions are positive even numbers (multiples of 2)
  targetWidth = Math.max(2, Math.floor(targetWidth / 2) * 2);
  targetHeight = Math.max(2, Math.floor(targetHeight / 2) * 2);

  // Build inputs and filter_complex
  const baseInputArgs = ['-y', '-threads', '0'];
  for (const f of files) {
    baseInputArgs.push('-i', f.filePath);
  }

  const filterParts = [];
  const concatInputs = [];

  for (let i = 0; i < files.length; i++) {
    const p = probedList[i];

    // Scale and pad to target resolution, set uniform fps to 30 and SAR 1:1
    // CRITICAL: Ensure x and y in pad filter are strictly even integers (multiples of 2) to prevent yuv420p chroma crashes!
    if (allSameDimensions && p.width === targetWidth && p.height === targetHeight) {
      // Dimensions already match target: bypass expensive scaling and padding!
      filterParts.push(`[${i}:v]setsar=1,fps=30[v${i}]`);
    } else {
      filterParts.push(
        `[${i}:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:trunc((ow-iw)/4)*2:trunc((oh-ih)/4)*2:color=black,setsar=1,fps=30[v${i}]`
      );
    }

    // Audio stream normalization:
    // If input has audio: resample to 48kHz stereo with async pts correction to prevent audio drift
    // If input has no audio: generate silent audio stream matching video duration
    if (p.hasAudio) {
      filterParts.push(`[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,aresample=async=1:first_pts=0[a${i}]`);
    } else {
      const dur = (p.duration && p.duration > 0) ? p.duration : 1;
      filterParts.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=end=${dur},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    }

    concatInputs.push(`[v${i}][a${i}]`);
  }

  filterParts.push(`${concatInputs.join('')}concat=n=${files.length}:v=1:a=1[outv][outa]`);

  // Detect optimal encoder
  const selectedEncoder = await detectBestEncoder();
  const encoderFlags = getEncoderFlags(selectedEncoder.name);

  const primaryArgs = [
    ...baseInputArgs,
    '-filter_complex', filterParts.join(';'),
    '-map', '[outv]',
    '-map', '[outa]',
    ...encoderFlags,
    '-c:a', 'aac',
    '-b:a', '192k',
    '-max_muxing_queue_size', '4096',
    '-movflags', '+faststart',
    outputPath
  ];

  try {
    await runFfmpegWithProgress({
      args: primaryArgs,
      totalDuration,
      onProgress,
      abortSignal,
      baseProgress: 15,
      maxProgress: 95,
      stageName: selectedEncoder.isHardware
        ? `Hardware-Accelerated Transcoding (${selectedEncoder.name})`
        : 'High-Speed Transcoding (libx264)'
    });
  } catch (encErr) {
    // If a hardware encoder failed mid-run, automatically fallback to CPU libx264
    if (selectedEncoder.name !== 'libx264') {
      console.warn(`[Hardware Encoder Warning] ${selectedEncoder.name} failed (${encErr.message}). Falling back to CPU libx264...`);
      try {
        if (fs.existsSync(outputPath)) {
          await fs.promises.unlink(outputPath);
        }
      } catch (_) {}

      const cpuFallbackArgs = [
        ...baseInputArgs,
        '-filter_complex', filterParts.join(';'),
        '-map', '[outv]',
        '-map', '[outa]',
        ...getEncoderFlags('libx264'),
        '-c:a', 'aac',
        '-b:a', '192k',
        '-max_muxing_queue_size', '4096',
        '-movflags', '+faststart',
        outputPath
      ];

      await runFfmpegWithProgress({
        args: cpuFallbackArgs,
        totalDuration,
        onProgress,
        abortSignal,
        baseProgress: 15,
        maxProgress: 95,
        stageName: 'CPU Transcoding Fallback (libx264)'
      });
    } else {
      throw encErr;
    }
  }

  // Verify transcoded output
  const verified = await verifyOutputFile(outputPath);
  if (onProgress) onProgress(100, 'Completed');

  return {
    isTranscoded: true,
    transcodeReason: transcodeReason || 'Incompatible stream parameters normalized',
    duration: verified.probed.duration || totalDuration,
    fileSize: verified.fileSize
  };
}

/**
 * Runs FFmpeg and extracts actual progress from stderr time output.
 */
function runFfmpegWithProgress({ args, totalDuration, onProgress, abortSignal, baseProgress = 10, maxProgress = 95, stageName = 'Processing' }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.ffmpegPath, args, { windowsHide: true });
    let stderr = '';

    if (abortSignal) {
      abortSignal.addEventListener('abort', () => {
        try {
          proc.kill('SIGTERM');
        } catch (_) {}
        reject(new Error('Merge job was cancelled by user.'));
      });
    }

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;

      // Match time=HH:MM:SS.xx
      const timeMatch = text.match(/time=(\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
      if (timeMatch && totalDuration > 0) {
        const curSec = parseTimeInSeconds(timeMatch[1]);
        const ratio = Math.min(1, Math.max(0, curSec / totalDuration));
        const currentProgress = Math.round(baseProgress + ratio * (maxProgress - baseProgress));
        if (onProgress) {
          onProgress(currentProgress, `${stageName} (${Math.round(ratio * 100)}%)`);
        }
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn FFmpeg: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const errSnippet = stderr.slice(-600).trim();
        reject(new Error(`FFmpeg failed with exit code ${code}. Details: ${errSnippet}`));
      }
    });
  });
}


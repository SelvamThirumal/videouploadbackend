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
 * Returns { compatible: boolean, videoCompatible: boolean, audioCompatible: boolean, reason?: string }.
 */
export function checkConcatCompatibility(probedList) {
  if (probedList.length <= 1) {
    return { compatible: true, videoCompatible: true, audioCompatible: true };
  }

  const first = probedList[0];
  const firstVCodec = normalizeVideoCodec(first.videoCodec);
  const firstACodec = normalizeAudioCodec(first.audioCodec);
  const firstPix = normalizePixFmt(first.pixFmt);

  let videoCompatible = true;
  let audioCompatible = true;
  let reason = '';

  for (let i = 1; i < probedList.length; i++) {
    const cur = probedList[i];
    const curVCodec = normalizeVideoCodec(cur.videoCodec);
    const curACodec = normalizeAudioCodec(cur.audioCodec);
    const curPix = normalizePixFmt(cur.pixFmt);

    if (curVCodec !== firstVCodec || curVCodec === 'unknown') {
      videoCompatible = false;
      if (!reason) reason = `Video codec mismatch across parts (${first.videoCodec} vs ${cur.videoCodec})`;
      break;
    }
    if (cur.width !== first.width || cur.height !== first.height) {
      videoCompatible = false;
      if (!reason) reason = `Resolution mismatch across parts (${first.width}x${first.height} vs ${cur.width}x${cur.height})`;
      break;
    }
    if (curPix !== firstPix) {
      videoCompatible = false;
      if (!reason) reason = `Pixel format mismatch across parts (${first.pixFmt} vs ${cur.pixFmt})`;
      break;
    }
    if (cur.hasAudio !== first.hasAudio) {
      audioCompatible = false;
      if (!reason) reason = 'Audio stream layout difference (some clips have audio, others are silent)';
    } else if (first.hasAudio) {
      if (curACodec !== firstACodec) {
        audioCompatible = false;
        if (!reason) reason = `Audio codec mismatch across parts (${first.audioCodec} vs ${cur.audioCodec})`;
      } else if (first.audioSampleRate && cur.audioSampleRate && first.audioSampleRate !== cur.audioSampleRate) {
        audioCompatible = false;
        if (!reason) reason = `Audio sample rate mismatch (${first.audioSampleRate}Hz vs ${cur.audioSampleRate}Hz)`;
      } else if (first.audioChannels && cur.audioChannels && first.audioChannels !== cur.audioChannels) {
        audioCompatible = false;
        if (!reason) reason = `Audio channel mismatch (${first.audioChannels}ch vs ${cur.audioChannels}ch)`;
      }
    }
  }

  const compatible = videoCompatible && audioCompatible;
  return {
    compatible,
    videoCompatible,
    audioCompatible,
    reason: compatible ? undefined : reason
  };
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
      return [
        '-c:v', 'libx264',
        '-preset', config.ffmpegPreset || 'ultrafast',
        '-tune', 'fastdecode',
        '-crf', '24',
        '-pix_fmt', 'yuv420p',
        '-threads', '0',
        '-x264opts', 'no-mbtree:me=dia:subme=1:ref=1:rc-lookahead=0'
      ];
  }
}

/**
 * Merges video files using FFmpeg via multi-tier high-speed pipeline:
 * Tier 1: Lossless Concat Demuxer with Stream Copy (-c copy) -> ~1 to 2 seconds
 * Tier 2: Lossless MPEG-TS Stream Remux & Concat (-c copy)   -> ~2 to 3 seconds
 * Tier 3: Hybrid Fast Path (Lossless Video Copy + Audio Fix) -> ~2 to 4 seconds
 * Tier 4: Ultra-Speed Transcode (Only when resolutions or codecs completely differ)
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

  // 1. Probe all files in parallel for maximum startup speed
  if (onProgress) onProgress(5, 'Analyzing video streams');
  const probedList = await Promise.all(files.map((f) => probeVideo(f.filePath)));
  let totalDuration = probedList.reduce((acc, p) => acc + (p.duration || 0), 0);

  // Single file handling: instantaneous file copy
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

  // TIER 1: Direct Concat Demuxer with Stream Copy (-c copy) — 1 to 2 seconds
  if (compatResult.compatible) {
    try {
      return await executeFastConcat({
        files,
        outputPath,
        tempDir,
        totalDuration,
        onProgress,
        abortSignal
      });
    } catch (fastErr) {
      console.warn(`[Fast Concat Warning] Direct stream copy demuxer failed (${fastErr.message}). Attempting Tier 2 Lossless MPEG-TS remux...`);
      try {
        if (fs.existsSync(outputPath)) await fs.promises.unlink(outputPath);
      } catch (_) {}

      // TIER 2: Lossless MPEG-TS Remux & Concat — 2 to 3 seconds
      try {
        return await executeTsLosslessConcat({
          files,
          probedList,
          outputPath,
          tempDir,
          totalDuration,
          onProgress,
          abortSignal
        });
      } catch (tsErr) {
        console.warn(`[TS Concat Warning] TS stream copy failed (${tsErr.message}). Falling back to next tier...`);
        try {
          if (fs.existsSync(outputPath)) await fs.promises.unlink(outputPath);
        } catch (_) {}
      }
    }
  }

  // TIER 3: Hybrid Fast Path (Video Copy -c:v copy + Fast Audio Normalization) — 2 to 4 seconds
  // Triggers when video codec & dimensions match, but audio has different sample rates or silence
  if (compatResult.videoCompatible) {
    try {
      if (onProgress) onProgress(15, 'Applying instant video stream copy with fast audio normalization');
      return await executeHybridConcat({
        files,
        probedList,
        outputPath,
        tempDir,
        totalDuration,
        onProgress,
        abortSignal
      });
    } catch (hybridErr) {
      console.warn(`[Hybrid Concat Warning] Hybrid copy failed (${hybridErr.message}). Falling back to ultra-speed transcode...`);
      try {
        if (fs.existsSync(outputPath)) await fs.promises.unlink(outputPath);
      } catch (_) {}
    }
  }

  // TIER 4: High-Speed Transcoding (Only when video resolutions or codecs genuinely differ)
  if (onProgress) onProgress(15, 'Normalizing video streams (Ultra-Speed Transcode)');
  return await executeTranscodeConcat({
    files,
    probedList,
    outputPath,
    totalDuration,
    transcodeReason: compatResult.reason || 'Streams require resolution/codec normalization',
    onProgress,
    abortSignal
  });
}

/**
 * Tier 2: Lossless MPEG-TS Stream Copy Concat.
 * Remuxes inputs into lightweight temporary .ts files without re-encoding video frames,
 * then concatenates the transport streams losslessly.
 */
async function executeTsLosslessConcat({ files, probedList, outputPath, tempDir, totalDuration, onProgress, abortSignal }) {
  if (onProgress) onProgress(20, 'Remuxing streams into lossless TS containers');

  const tsFiles = [];
  const runId = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const firstCodec = normalizeVideoCodec(probedList[0]?.videoCodec);
  const bsfV = firstCodec === 'hevc' ? 'hevc_mp4toannexb' : 'h264_mp4toannexb';

  try {
    for (let i = 0; i < files.length; i++) {
      if (abortSignal?.aborted) throw new Error('Merge cancelled by user.');
      const tsPath = path.join(tempDir, `stream_${runId}_part${i}.ts`);
      tsFiles.push(tsPath);

      const remuxArgs = [
        '-y',
        '-i', files[i].filePath,
        '-c', 'copy',
        '-bsf:v', bsfV,
        '-f', 'mpegts',
        tsPath
      ];

      await execAsync(config.ffmpegPath, remuxArgs, { abortSignal });
      if (onProgress) {
        const pct = Math.round(20 + ((i + 1) / files.length) * 35);
        onProgress(pct, `Prepared lossless stream ${i + 1}/${files.length}`);
      }
    }

    if (onProgress) onProgress(60, 'Concatenating lossless transport streams');

    const concatInput = `concat:${tsFiles.map((f) => f.replace(/\\/g, '/')).join('|')}`;
    const mergeArgs = [
      '-y',
      '-i', concatInput,
      '-c', 'copy',
      '-bsf:a', 'aac_adtstoasc',
      '-fflags', '+genpts',
      '-avoid_negative_ts', 'make_zero',
      '-movflags', '+faststart',
      outputPath
    ];

    await execAsync(config.ffmpegPath, mergeArgs, { abortSignal });

    const verified = await verifyOutputFile(outputPath);
    if (onProgress) onProgress(100, 'Completed (Lossless TS Copy)');

    return {
      isTranscoded: false,
      duration: verified.probed.duration || totalDuration,
      fileSize: verified.fileSize
    };
  } finally {
    for (const ts of tsFiles) {
      try {
        if (fs.existsSync(ts)) await fs.promises.unlink(ts);
      } catch (_) {}
    }
  }
}

/**
 * Tier 3: Hybrid Fast Path.
 * When video streams are identical in codec & dimensions, but audio differs (sample rate, channels, or silent):
 * Normalizes ONLY the tiny audio track into temporary clips with -c:v copy (takes < 1 second),
 * then stream-copies the entire batch together losslessly!
 */
async function executeHybridConcat({ files, probedList, outputPath, tempDir, totalDuration, onProgress, abortSignal }) {
  if (onProgress) onProgress(15, 'Normalizing audio tracks while keeping 100% video stream copy');

  const normalizedFiles = [];
  const tempFilesToClean = [];
  const runId = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

  try {
    for (let i = 0; i < files.length; i++) {
      if (abortSignal?.aborted) throw new Error('Merge cancelled by user.');
      const p = probedList[i];
      const needsAudioFix = !p.hasAudio || p.audioSampleRate !== 48000 || p.audioChannels !== 2 || normalizeAudioCodec(p.audioCodec) !== 'aac';

      if (!needsAudioFix) {
        normalizedFiles.push(files[i]);
      } else {
        const normPath = path.join(tempDir, `hybrid_norm_${runId}_part${i}.mp4`);
        tempFilesToClean.push(normPath);

        let args;
        if (p.hasAudio) {
          args = [
            '-y',
            '-i', files[i].filePath,
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-ar', '48000',
            '-ac', '2',
            '-b:a', '128k',
            '-movflags', '+faststart',
            normPath
          ];
        } else {
          const dur = (p.duration && p.duration > 0) ? p.duration : 1;
          args = [
            '-y',
            '-i', files[i].filePath,
            '-f', 'lavfi',
            '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-t', dur.toString(),
            '-shortest',
            '-movflags', '+faststart',
            normPath
          ];
        }

        await execAsync(config.ffmpegPath, args, { abortSignal });
        normalizedFiles.push({ filePath: normPath });
      }

      if (onProgress) {
        const pct = Math.round(15 + ((i + 1) / files.length) * 20);
        onProgress(pct, `Normalized audio track ${i + 1}/${files.length}`);
      }
    }

    return await executeFastConcat({
      files: normalizedFiles,
      outputPath,
      tempDir,
      totalDuration,
      onProgress,
      abortSignal
    });
  } finally {
    for (const f of tempFilesToClean) {
      try {
        if (fs.existsSync(f)) await fs.promises.unlink(f);
      } catch (_) {}
    }
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
  let allSameDimensions = true;
  const first = probedList[0] || {};
  let maxWidth = 0;
  let maxHeight = 0;

  for (const p of probedList) {
    if (p.width > maxWidth) maxWidth = p.width;
    if (p.height > maxHeight) maxHeight = p.height;
    if (p.width !== first.width || p.height !== first.height) {
      allSameDimensions = false;
    }
  }

  let targetWidth;
  let targetHeight;

  if (allSameDimensions && first.width > 0 && first.height > 0) {
    targetWidth = first.width;
    targetHeight = first.height;
  } else {
    // Avoid slow 1080p/4k upscaling on low-resource CPU: cap target at 1280x720 max
    targetWidth = Math.min(maxWidth || 1280, 1280);
    targetHeight = Math.min(maxHeight || 720, 720);
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

    // Scale and pad to target resolution with fast_bilinear
    // CRITICAL: Ensure x and y in pad filter are strictly even integers (multiples of 2) to prevent yuv420p chroma crashes!
    if (allSameDimensions && p.width === targetWidth && p.height === targetHeight) {
      // Dimensions already match target: bypass expensive scaling and padding!
      filterParts.push(`[${i}:v]setsar=1[v${i}]`);
    } else {
      filterParts.push(
        `[${i}:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=${targetWidth}:${targetHeight}:trunc((ow-iw)/4)*2:trunc((oh-ih)/4)*2:color=black,setsar=1[v${i}]`
      );
    }

    // Audio stream normalization:
    // If input has audio: resample to 44.1kHz stereo with async pts correction
    // If input has no audio: generate silent audio stream matching video duration
    if (p.hasAudio) {
      filterParts.push(`[${i}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,aresample=async=1:first_pts=0[a${i}]`);
    } else {
      const dur = (p.duration && p.duration > 0) ? p.duration : 1;
      filterParts.push(`anullsrc=channel_layout=stereo:sample_rate=44100,atrim=end=${dur},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
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
    '-b:a', '128k',
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


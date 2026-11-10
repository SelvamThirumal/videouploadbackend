import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { config } from '../../config/env.js';

function execAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Process ${cmd} exited with code ${code}. Stderr: ${stderr.slice(-500)}`));
    });
  });
}

/**
 * Audio Editing Studio Service
 * Supports multitrack mixing, trimming, fading, volume adjustment,
 * playback speed adjustment, and audio extraction from video.
 */
export async function mixAudioTracks({
  tracks, // Array of { filePath, startTime = 0, volume = 1, fadeIn = 0, fadeOut = 0, speed = 1 }
  outputDir,
  outputFormat = 'mp3' // 'mp3' or 'wav'
}) {
  if (!tracks || tracks.length === 0) {
    throw new Error('At least one audio track is required.');
  }

  const runId = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const outFileName = `studio_mix_${runId}.${outputFormat}`;
  const outFilePath = path.join(outputDir, outFileName);

  const args = ['-y'];

  // 1. Add all input files
  for (const track of tracks) {
    args.push('-i', track.filePath);
  }

  // 2. Build audio filter graph
  const filterParts = [];
  tracks.forEach((track, idx) => {
    let trackFilters = [];

    // Volume adjustment
    if (track.volume !== undefined && track.volume !== 1) {
      trackFilters.push(`volume=${Math.max(0, parseFloat(track.volume))}`);
    }

    // Fade in
    if (track.fadeIn && track.fadeIn > 0) {
      trackFilters.push(`afade=t=in:st=0:d=${parseFloat(track.fadeIn)}`);
    }

    // Fade out
    if (track.fadeOut && track.fadeOut > 0 && track.duration) {
      const fadeStart = Math.max(0, track.duration - parseFloat(track.fadeOut));
      trackFilters.push(`afade=t=out:st=${fadeStart}:d=${parseFloat(track.fadeOut)}`);
    }

    // Playback speed
    if (track.speed && track.speed !== 1) {
      const spd = Math.max(0.5, Math.min(2.0, parseFloat(track.speed)));
      trackFilters.push(`atempo=${spd}`);
    }

    // Delay start time (adelay)
    if (track.startTime && track.startTime > 0) {
      const delayMs = Math.round(parseFloat(track.startTime) * 1000);
      trackFilters.push(`adelay=${delayMs}|${delayMs}`);
    }

    const filterString = trackFilters.length > 0 ? trackFilters.join(',') : 'anull';
    filterParts.push(`[${idx}:a]${filterString}[a${idx}]`);
  });

  // 3. Mix all tracks into a single stream
  if (tracks.length > 1) {
    const mixInputs = tracks.map((_, idx) => `[a${idx}]`).join('');
    filterParts.push(`${mixInputs}amix=inputs=${tracks.length}:duration=longest:dropout_transition=2[outa]`);
  } else {
    filterParts.push(`[a0]anull[outa]`);
  }

  args.push('-filter_complex', filterParts.join(';'));
  args.push('-map', '[outa]');

  if (outputFormat === 'wav') {
    args.push('-c:a', 'pcm_s16le');
  } else {
    args.push('-c:a', 'libmp3lame', '-b:a', '256k');
  }

  args.push(outFilePath);

  await execAsync(config.ffmpegPath, args);
  const stat = await fs.promises.stat(outFilePath);

  return {
    fileName: outFileName,
    filePath: outFilePath,
    fileSize: stat.size,
    format: outputFormat,
    tracksCount: tracks.length
  };
}

/**
 * Extracts pure audio track from an uploaded video
 */
export async function extractAudioFromVideo({ filePath, outputDir, format = 'mp3' }) {
  const runId = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const outFileName = `extracted_audio_${runId}.${format}`;
  const outFilePath = path.join(outputDir, outFileName);

  const args = [
    '-y',
    '-i', filePath,
    '-vn'
  ];

  if (format === 'wav') {
    args.push('-c:a', 'pcm_s16le');
  } else {
    args.push('-c:a', 'libmp3lame', '-b:a', '256k');
  }

  args.push(outFilePath);

  await execAsync(config.ffmpegPath, args);
  const stat = await fs.promises.stat(outFilePath);

  return {
    fileName: outFileName,
    filePath: outFilePath,
    fileSize: stat.size,
    format
  };
}

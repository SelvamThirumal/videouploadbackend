import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { config } from '../../config/env.js';
import { probeVideo } from '../ffmpegService.js';

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
 * AI Background Noise Remover & Speech Enhancement Engine
 * Supports both Audio files (MP3, WAV, AAC, M4A, FLAC, OGG)
 * and Video files (MP4, MOV, MKV, WebM, AVI).
 *
 * For videos, it extracts audio, applies noise suppression filters,
 * and remuxes with the original video stream via stream-copy (-c:v copy)
 * ensuring zero quality loss and blazing speed.
 */
export async function removeAudioNoise({
  filePath,
  outputDir,
  mode = 'medium', // 'light', 'medium', 'strong', 'voice_focus', 'custom'
  customNoiseFloor = -35, // -50 to -10 dB
  customVoiceBoost = false,
  highpassFreq = 80,
  lowpassFreq = 12000
}) {
  const isVideo = isVideoFile(filePath);
  const runId = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const ext = path.extname(filePath).toLowerCase();

  // Determine FFmpeg audio filter string based on selected mode
  let audioFilter = '';
  switch (mode) {
    case 'light':
      // Subtle room ambience & mild fan reduction
      audioFilter = 'afftdn=nf=-25:tn=1:tr=1,highpass=f=60,lowpass=f=14000';
      break;

    case 'strong':
      // Heavy traffic, loud AC, keyboard clicks, rain/wind noise
      audioFilter = 'afftdn=nf=-45:tn=1:tr=1,highpass=f=100,lowpass=f=10000,dynaudnorm=f=120:g=15';
      break;

    case 'voice_focus':
      // Isolate speech, attenuate background, boost vocal clarity & presence
      audioFilter = 'afftdn=nf=-35:tn=1:tr=1,highpass=f=90,lowpass=f=11000,equalizer=f=1200:width_type=h:width=2200:g=4,dynaudnorm=f=150:g=18';
      break;

    case 'custom': {
      const nf = Math.min(-10, Math.max(-60, parseInt(customNoiseFloor, 10) || -35));
      const hp = Math.min(300, Math.max(30, parseInt(highpassFreq, 10) || 80));
      const lp = Math.min(18000, Math.max(4000, parseInt(lowpassFreq, 10) || 12000));
      let filter = `afftdn=nf=${nf}:tn=1:tr=1,highpass=f=${hp},lowpass=f=${lp}`;
      if (customVoiceBoost) {
        filter += ',equalizer=f=1200:width_type=h:width=2000:g=4,dynaudnorm=f=150:g=15';
      }
      audioFilter = filter;
      break;
    }

    case 'medium':
    default:
      // Standard balanced noise reduction
      audioFilter = 'afftdn=nf=-35:tn=1:tr=1,highpass=f=80,lowpass=f=12000,speechnorm=e=4:r=0.0001:l=1';
      break;
  }

  if (isVideo) {
    // Process Video: Extract, filter audio, and remux with stream copy for video
    const outFileName = `cleaned_${path.parse(filePath).name}_${runId}.mp4`;
    const outFilePath = path.join(outputDir, outFileName);

    const args = [
      '-y',
      '-i', filePath,
      '-af', audioFilter,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      outFilePath
    ];

    await execAsync(config.ffmpegPath, args);
    const stat = await fs.promises.stat(outFilePath);

    return {
      type: 'video',
      mode,
      fileName: outFileName,
      filePath: outFilePath,
      fileSize: stat.size,
      filterApplied: audioFilter
    };
  } else {
    // Process Audio: Output clean MP3 and WAV
    const outFileName = `cleaned_${path.parse(filePath).name}_${runId}.mp3`;
    const outFilePath = path.join(outputDir, outFileName);

    const args = [
      '-y',
      '-i', filePath,
      '-af', audioFilter,
      '-c:a', 'libmp3lame',
      '-b:a', '256k',
      outFilePath
    ];

    await execAsync(config.ffmpegPath, args);
    const stat = await fs.promises.stat(outFilePath);

    return {
      type: 'audio',
      mode,
      fileName: outFileName,
      filePath: outFilePath,
      fileSize: stat.size,
      filterApplied: audioFilter
    };
  }
}

/**
 * Checks if a file path is a video based on extension
 */
export function isVideoFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ['.mp4', '.mov', '.mkv', '.webm', '.avi', '.flv', '.wmv', '.m4v'].includes(ext);
}

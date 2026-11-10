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
      else reject(new Error(`Process ${cmd} exited with code ${code}. Stderr: ${stderr.slice(-600)}`));
    });
  });
}

function getSystemFontFile() {
  if (process.platform === 'win32') {
    const candidates = [
      'C:/Windows/Fonts/arial.ttf',
      'C:/Windows/Fonts/calibri.ttf',
      'C:/Windows/Fonts/segoeui.ttf'
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        return c.replace(/\\/g, '/').replace(/:/g, '\\:');
      }
    }
  } else {
    const linuxCandidates = [
      '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
      '/usr/share/fonts/truetype/freefont/FreeSans.ttf',
      '/usr/share/fonts/TTF/DejaVuSans.ttf'
    ];
    for (const c of linuxCandidates) {
      if (fs.existsSync(c)) return c;
    }
  }
  return null;
}

const RESOLUTION_MAP = {
  '16:9': {
    '480p': { w: 854, h: 480 },
    '720p': { w: 1280, h: 720 },
    '1080p': { w: 1920, h: 1080 },
    '2k': { w: 2560, h: 1440 },
    '4k': { w: 3840, h: 2160 }
  },
  '9:16': {
    '480p': { w: 480, h: 854 },
    '720p': { w: 720, h: 1280 },
    '1080p': { w: 1080, h: 1920 },
    '2k': { w: 1440, h: 2560 },
    '4k': { w: 2160, h: 3840 }
  },
  '1:1': {
    '480p': { w: 480, h: 480 },
    '720p': { w: 720, h: 720 },
    '1080p': { w: 1080, h: 1080 },
    '2k': { w: 1440, h: 1440 },
    '4k': { w: 2160, h: 2160 }
  },
  '4:5': {
    '480p': { w: 480, h: 600 },
    '720p': { w: 720, h: 900 },
    '1080p': { w: 1080, h: 1350 },
    '2k': { w: 1440, h: 1800 },
    '4k': { w: 2160, h: 2700 }
  }
};

/**
 * Professional Video Export Studio Service
 * Converts timeline state (clips, trims, overlays, text, transitions, effects, audio)
 * into a production-grade FFmpeg filter_complex rendering command.
 */
export async function exportStudioVideo({
  timeline,
  outputDir,
  resolution = '1080p',
  aspectRatio = '16:9',
  fps = 30,
  format = 'mp4',
  videoBitrate = '8M',
  audioBitrate = '192k'
}) {
  const runId = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const outFileName = `avinz_studio_${runId}.${format}`;
  const outFilePath = path.join(outputDir, outFileName);

  const resKey = (resolution || '1080p').toLowerCase();
  const arKey = aspectRatio || '16:9';
  const targetDim = (RESOLUTION_MAP[arKey] && RESOLUTION_MAP[arKey][resKey]) || { w: 1920, h: 1080 };
  const targetFps = parseInt(fps, 10) || 30;

  const videoClips = timeline?.videoClips || [];
  const audioClips = timeline?.audioClips || [];
  const effects = timeline?.effects || [];
  const textOverlays = timeline?.textOverlays || [];

  if (videoClips.length === 0) {
    throw new Error('Timeline must contain at least one video or image clip to export.');
  }

  const args = ['-y'];

  // Input mapping
  const inputFiles = [];
  videoClips.forEach(c => inputFiles.push(c.filePath));
  audioClips.forEach(a => inputFiles.push(a.filePath));

  inputFiles.forEach(f => args.push('-i', f));

  // Build filter graph
  const filterGraph = [];
  const processedVideoStreams = [];

  videoClips.forEach((clip, idx) => {
    let clipFilters = [];

    // Trim start / duration
    if (clip.trimStart && clip.trimStart > 0) {
      clipFilters.push(`trim=start=${clip.trimStart}`);
      clipFilters.push('setpts=PTS-STARTPTS');
    }
    if (clip.duration && clip.duration > 0) {
      clipFilters.push(`trim=duration=${clip.duration}`);
      clipFilters.push('setpts=PTS-STARTPTS');
    }

    // Playback Speed
    if (clip.speed && clip.speed !== 1) {
      const spd = Math.max(0.25, Math.min(4.0, parseFloat(clip.speed)));
      clipFilters.push(`setpts=${(1 / spd).toFixed(4)}*PTS`);
    }

    // Scale to target dimensions with letterbox/pillarbox padding
    clipFilters.push(`scale=${targetDim.w}:${targetDim.h}:force_original_aspect_ratio=decrease`);
    clipFilters.push(`pad=${targetDim.w}:${targetDim.h}:(ow-iw)/2:(oh-ih)/2:black`);
    clipFilters.push(`fps=${targetFps}`);

    const streamTag = `v${idx}`;
    filterGraph.push(`[${idx}:v]${clipFilters.join(',')}[${streamTag}]`);
    processedVideoStreams.push(`[${streamTag}]`);
  });

  // Concatenate multiple video clips if more than 1
  let masterVideoStream = '[v0]';
  if (processedVideoStreams.length > 1) {
    const concatInput = processedVideoStreams.join('');
    filterGraph.push(`${concatInput}concat=n=${processedVideoStreams.length}:v=1:a=0[vconcat]`);
    masterVideoStream = '[vconcat]';
  }

  // Apply Video Effects (Vignette, Black & White, Sepia, Glow, Blur)
  let effectStream = masterVideoStream;
  if (effects && effects.length > 0) {
    const effectFilters = [];
    effects.forEach(eff => {
      if (eff === 'black_and_white') effectFilters.push('hue=s=0');
      if (eff === 'sepia') effectFilters.push('colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131');
      if (eff === 'vignette') effectFilters.push('vignette=PI/4');
      if (eff === 'glow') effectFilters.push('curves=all=\'0/0 0.5/0.6 1/1\'');
      if (eff === 'blur') effectFilters.push('boxblur=2:1');
      if (eff === 'film_grain') effectFilters.push('noise=alls=15:allf=t+u');
      if (eff === 'cinematic') effectFilters.push('eq=contrast=1.15:saturation=1.2:brightness=0.02');
    });

    if (effectFilters.length > 0) {
      filterGraph.push(`${masterVideoStream}${effectFilters.join(',')}[veffects]`);
      effectStream = '[veffects]';
    }
  }

  // Apply Text Overlays using drawtext filter
  let finalVideoStream = effectStream;
  if (textOverlays && textOverlays.length > 0) {
    const fontFile = getSystemFontFile();
    const fontOption = fontFile ? `fontfile='${fontFile}':` : '';
    const drawTextFilters = [];

    textOverlays.forEach((tItem) => {
      const sanitizedText = (tItem.text || '').replace(/'/g, '\\\'').replace(/:/g, '\\:');
      const fontSize = tItem.fontSize || 36;
      const fontColor = tItem.fontColor || 'white';
      const x = tItem.x !== undefined ? tItem.x : '(w-text_w)/2';
      const y = tItem.y !== undefined ? tItem.y : 'h-th-60';

      drawTextFilters.push(`drawtext=${fontOption}text='${sanitizedText}':fontcolor=${fontColor}:fontsize=${fontSize}:x=${x}:y=${y}:box=1:boxcolor=black@0.5:boxborderw=5`);
    });

    if (drawTextFilters.length > 0) {
      filterGraph.push(`${effectStream}${drawTextFilters.join(',')}[vfinal]`);
      finalVideoStream = '[vfinal]';
    }
  }

  // Handle Audio Tracks
  let hasAudio = false;
  if (audioClips.length > 0) {
    const audioStartIndex = videoClips.length;
    const audioStreams = [];
    audioClips.forEach((ac, aIdx) => {
      const inputIdx = audioStartIndex + aIdx;
      const vol = ac.volume !== undefined ? ac.volume : 1;
      filterGraph.push(`[${inputIdx}:a]volume=${vol}[aud${aIdx}]`);
      audioStreams.push(`[aud${aIdx}]`);
    });

    if (audioStreams.length > 1) {
      filterGraph.push(`${audioStreams.join('')}amix=inputs=${audioStreams.length}:duration=first[afinal]`);
    } else {
      filterGraph.push(`${audioStreams[0]}anull[afinal]`);
    }
    hasAudio = true;
  }

  args.push('-filter_complex', filterGraph.join(';'));
  args.push('-map', finalVideoStream);

  if (hasAudio) {
    args.push('-map', '[afinal]');
    args.push('-c:a', 'aac', '-b:a', audioBitrate);
  }

  if (format === 'webm') {
    args.push('-c:v', 'libvpx-vp9', '-b:v', videoBitrate);
  } else {
    args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-pix_fmt', 'yuv420p');
    args.push('-movflags', '+faststart');
  }

  args.push(outFilePath);

  await execAsync(config.ffmpegPath, args);
  const stat = await fs.promises.stat(outFilePath);

  return {
    fileName: outFileName,
    filePath: outFilePath,
    fileSize: stat.size,
    resolution: `${targetDim.w}x${targetDim.h}`,
    fps: targetFps,
    format
  };
}

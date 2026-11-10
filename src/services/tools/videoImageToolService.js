import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import archiver from 'archiver';
import { config } from '../../config/env.js';
import { probeVideo } from '../ffmpegService.js';

function execAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Process ${cmd} exited with code ${code}. Stderr: ${stderr.slice(-400)}`));
    });
  });
}

/**
 * Video to Image Converter
 * Extracts images at custom timestamps, periodic intervals, or generates contact sheets.
 */
export async function extractVideoImages({
  filePath,
  outputDir,
  mode = 'interval', // 'timestamp', 'interval', 'contact_sheet', 'thumbnail'
  timestamp = '00:00:01',
  intervalSeconds = 5,
  contactSheetCols = 4
}) {
  const probed = await probeVideo(filePath);
  const totalDuration = probed.duration || 10;
  const runId = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const framesDir = path.join(outputDir, `frames_${runId}`);

  if (!fs.existsSync(framesDir)) {
    await fs.promises.mkdir(framesDir, { recursive: true });
  }

  // 1. Single timestamp mode
  if (mode === 'timestamp' || mode === 'thumbnail') {
    let targetTime = timestamp;
    if (mode === 'thumbnail') {
      const midSec = Math.max(0.5, totalDuration * 0.15);
      targetTime = midSec.toFixed(2);
    }

    const singleFileName = `frame_${runId}.jpg`;
    const singleFilePath = path.join(outputDir, singleFileName);

    const args = [
      '-y',
      '-ss', targetTime.toString(),
      '-i', filePath,
      '-vframes', '1',
      '-q:v', '2',
      singleFilePath
    ];

    await execAsync(config.ffmpegPath, args);
    const stat = await fs.promises.stat(singleFilePath);

    return {
      mode,
      totalDuration,
      singleImage: {
        fileName: singleFileName,
        filePath: singleFilePath,
        fileSize: stat.size,
        timestamp: targetTime
      }
    };
  }

  // 2. Periodic interval extraction (every N seconds)
  if (mode === 'interval') {
    const step = Math.max(1, parseInt(intervalSeconds, 10) || 5);
    const pattern = path.join(framesDir, 'frame_%04d.jpg');

    // Extract 1 frame every `step` seconds
    const args = [
      '-y',
      '-i', filePath,
      '-vf', `fps=1/${step}`,
      '-q:v', '2',
      pattern
    ];

    await execAsync(config.ffmpegPath, args);

    const extractedFiles = (await fs.promises.readdir(framesDir))
      .filter(f => f.endsWith('.jpg'))
      .map((f, idx) => ({
        fileName: f,
        filePath: path.join(framesDir, f),
        timestampSeconds: idx * step
      }));

    // Bundle extracted frames into ZIP
    const zipName = `video_frames_${runId}.zip`;
    const zipPath = path.join(outputDir, zipName);
    const outputStream = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    await new Promise((resolve, reject) => {
      outputStream.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(outputStream);
      archive.directory(framesDir, false);
      archive.finalize();
    });

    const zipStat = await fs.promises.stat(zipPath);

    return {
      mode: 'interval',
      totalDuration,
      intervalSeconds: step,
      totalFrames: extractedFiles.length,
      frames: extractedFiles.slice(0, 30), // Sample for UI preview
      zipArchive: {
        fileName: zipName,
        filePath: zipPath,
        fileSize: zipStat.size
      }
    };
  }

  // 3. Contact sheet / storyboard grid
  if (mode === 'contact_sheet') {
    const cols = Math.max(2, Math.min(8, parseInt(contactSheetCols, 10) || 4));
    const sheetFileName = `storyboard_${runId}.jpg`;
    const sheetFilePath = path.join(outputDir, sheetFileName);

    // Sample roughly 16 frames across duration into a contact sheet grid
    const numFrames = cols * 4; // e.g. 4x4 = 16
    const rate = numFrames / Math.max(1, totalDuration);

    const args = [
      '-y',
      '-i', filePath,
      '-vf', `fps=${rate.toFixed(4)},scale=320:-1,tile=${cols}x4`,
      '-q:v', '2',
      sheetFilePath
    ];

    await execAsync(config.ffmpegPath, args);
    const stat = await fs.promises.stat(sheetFilePath);

    return {
      mode: 'contact_sheet',
      totalDuration,
      singleImage: {
        fileName: sheetFileName,
        filePath: sheetFilePath,
        fileSize: stat.size,
        columns: cols,
        rows: 4
      }
    };
  }
}

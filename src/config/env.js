import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from server directory
const envPath = path.resolve(__dirname, '../../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

// Helper to auto-locate ffmpeg on Windows if not in PATH
function resolveBinary(binaryName) {
  // If explicitly set in environment
  const envVal = process.env[binaryName.toUpperCase() + '_PATH'];
  if (envVal && fs.existsSync(envVal)) return envVal;

  // Check WinGet default installation folder on Windows
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    if (localAppData) {
      const wingetDir = path.join(localAppData, 'Microsoft', 'WinGet', 'Packages');
      if (fs.existsSync(wingetDir)) {
        try {
          const pkgs = fs.readdirSync(wingetDir);
          for (const pkg of pkgs) {
            if (pkg.toLowerCase().includes('ffmpeg')) {
              const pkgPath = path.join(wingetDir, pkg);
              const subdirs = fs.readdirSync(pkgPath);
              for (const sub of subdirs) {
                const binPath = path.join(pkgPath, sub, 'bin', `${binaryName}.exe`);
                if (fs.existsSync(binPath)) return binPath;
              }
            }
          }
        } catch (_) {}
      }
    }
    const standardC = `C:\\ffmpeg\\bin\\${binaryName}.exe`;
    if (fs.existsSync(standardC)) return standardC;
  }

  // Fallback to command name
  return binaryName;
}

import os from 'os';

function getOptimalConcurrency() {
  if (process.env.MAX_CONCURRENT_MERGES) {
    return parseInt(process.env.MAX_CONCURRENT_MERGES, 10);
  }
  const cpuCount = os.cpus()?.length || 2;
  const freeMemGB = (os.freemem() || 0) / (1024 * 1024 * 1024);
  // Keep server responsive without exhausting CPU/RAM:
  // 1 worker on low spec systems, 2 on quad-core, up to 3-4 on high core systems
  if (freeMemGB < 2 || cpuCount <= 2) return 1;
  if (cpuCount <= 4) return 2;
  if (cpuCount <= 8) return 3;
  return 4;
}

export const config = {
  port: parseInt(process.env.PORT || '5000', 10),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/video_merger',
  clientUrl: process.env.CLIENT_URL || 'http://localhost:5173',
  // 1 TB = 1,048,576 MB (or from MAX_BATCH_SIZE_GB * 1024 or MAX_BATCH_SIZE_MB)
  maxBatchSizeMB: process.env.MAX_BATCH_SIZE_GB
    ? parseInt(process.env.MAX_BATCH_SIZE_GB, 10) * 1024
    : parseInt(process.env.MAX_BATCH_SIZE_MB || '1048576', 10), // 1 TB default
  maxFilesPerBatch: parseInt(process.env.MAX_FILES_PER_BATCH || '10000', 10),
  fileRetentionMinutes: parseInt(process.env.FILE_RETENTION_MINUTES || '10', 10), // 10 min after outputs ready
  tempFileRetentionMinutes: parseInt(process.env.TEMP_FILE_RETENTION_MINUTES || '60', 10), // 60 min for abandoned uploads
  tempDir: path.resolve(__dirname, '../../', process.env.TEMP_DIR || './temp'),
  ffmpegPath: resolveBinary('ffmpeg'),
  ffprobePath: resolveBinary('ffprobe'),
  maxConcurrentMerges: getOptimalConcurrency(),
  ffmpegVideoEncoder: process.env.FFMPEG_VIDEO_ENCODER || 'auto',
  ffmpegPreset: process.env.FFMPEG_PRESET || 'ultrafast',
  fiveMinuteTargetSeconds: parseInt(process.env.FIVE_MINUTE_TARGET_SECONDS || '300', 10),
  minFreeDiskSpaceMB: parseInt(process.env.MIN_FREE_DISK_SPACE_MB || '500', 10)
};

// Ensure tempDir exists
if (!fs.existsSync(config.tempDir)) {
  fs.mkdirSync(config.tempDir, { recursive: true });
}

export function validateEnv() {
  const sizeFormatted = config.maxBatchSizeMB >= 1048576
    ? `${(config.maxBatchSizeMB / 1048576).toFixed(1)} TB`
    : config.maxBatchSizeMB >= 1024
    ? `${(config.maxBatchSizeMB / 1024).toFixed(0)} GB`
    : `${config.maxBatchSizeMB} MB`;

  console.log('--- FASTBATCH Configuration ---');
  console.log(`Port: ${config.port}`);
  console.log(`MongoDB URI: ${config.mongoUri}`);
  console.log(`Client URL: ${config.clientUrl}`);
  console.log(`Max Batch Size: ${sizeFormatted} (${config.maxBatchSizeMB} MB)`);
  console.log(`Max Files Per Batch: ${config.maxFilesPerBatch}`);
  console.log(`Output Retention: ${config.fileRetentionMinutes} minutes after completion`);
  console.log(`Temp Directory: ${config.tempDir}`);
  console.log(`Max Concurrent Merges: ${config.maxConcurrentMerges} worker(s)`);
  console.log(`FFmpeg Video Encoder: ${config.ffmpegVideoEncoder}`);
  console.log(`FFmpeg CPU Preset: ${config.ffmpegPreset}`);
  console.log(`5-Minute Target: ${config.fiveMinuteTargetSeconds}s`);
  console.log('-------------------------------');
}

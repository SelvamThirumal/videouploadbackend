import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { config } from '../config/env.js';
import { isSupportedVideoFile } from '../utils/parseVideoFilename.js';

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Generate or read batchId
    const batchId = req.batchId || req.body.batchId || req.headers['x-batch-id'] || crypto.randomUUID();
    req.batchId = batchId;

    const uploadDir = path.join(config.tempDir, batchId, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Safe unique filename on disk to prevent collisions and path traversal
    const ext = path.extname(file.originalname).toLowerCase();
    const safeHash = crypto.randomBytes(8).toString('hex');
    const safeName = `${Date.now()}_${safeHash}${ext}`;
    cb(null, safeName);
  }
});

const fileFilter = (req, file, cb) => {
  if (isSupportedVideoFile(file.originalname)) {
    cb(null, true);
  } else {
    cb(new Error(`Unsupported file type for "${file.originalname}". Only video files are allowed.`), false);
  }
};

// 1 TB default upload limit per batch (configurable via env)
const maxBytes = config.maxBatchSizeMB * 1024 * 1024;

export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: maxBytes,
    files: config.maxFilesPerBatch || 10000
  }
});

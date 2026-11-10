import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { config } from '../config/env.js';
import {
  handleNoiseRemoval,
  handleMixAudio,
  handleExtractAudio,
  handleExportVideo,
  handleClearSession
} from '../controllers/studio/studioController.js';

const router = express.Router();

const studioUploadDir = path.join(config.tempDir, 'studio_uploads');
if (!fs.existsSync(studioUploadDir)) {
  fs.mkdirSync(studioUploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, studioUploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const safeName = `${Date.now()}_${Math.random().toString(36).substring(2, 8)}${ext}`;
    cb(null, safeName);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 1024 * 1024 * 1024, // 1 GB for studio video/audio
    files: 50
  }
});

// Studio Endpoints
router.post('/noise-remover', upload.single('media'), handleNoiseRemoval);
router.post('/audio/mix', upload.array('audioTracks', 10), handleMixAudio);
router.post('/audio/extract', upload.single('video'), handleExtractAudio);
router.post('/video/export', upload.array('mediaFiles', 30), handleExportVideo);
router.delete('/clear-session/:sessionId', handleClearSession);

export default router;

import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { config } from '../config/env.js';
import {
  handleImageReducer,
  handlePassportPhoto,
  handlePdfToWord,
  handleWordToExcel,
  handlePdfToZip,
  handleZipExtractor,
  handleImageConverter,
  handleVideoToImage,
  handleToolDownload
} from '../controllers/tools/toolsController.js';

const router = express.Router();

// Multer storage for tools uploads
const toolsUploadDir = path.join(config.tempDir, 'tools_uploads');
if (!fs.existsSync(toolsUploadDir)) {
  fs.mkdirSync(toolsUploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, toolsUploadDir);
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
    fileSize: 500 * 1024 * 1024, // 500 MB per file limit for tools
    files: 50
  }
});

// Tool Routes
router.post('/image-reducer', upload.array('images', 30), handleImageReducer);
router.post('/passport-photo', upload.single('photo'), handlePassportPhoto);
router.post('/pdf-to-word', upload.single('pdf'), handlePdfToWord);
router.post('/word-to-excel', upload.single('document'), handleWordToExcel);
router.post('/pdf-to-zip', upload.array('pdfs', 50), handlePdfToZip);
router.post('/zip-extractor', upload.single('zipFile'), handleZipExtractor);
router.post('/image-converter', upload.array('images', 30), handleImageConverter);
router.post('/video-to-image', upload.single('video'), handleVideoToImage);

// Secure Download Route
router.get('/download/:token/:fileName', handleToolDownload);

export default router;


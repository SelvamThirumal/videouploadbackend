import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import archiver from 'archiver';
import { config } from '../../config/env.js';
import { reduceImageSize, generatePassportPhoto, convertImageFormat } from '../../services/tools/imageToolService.js';
import { convertPdfToWord, bundlePdfsToZip } from '../../services/tools/pdfToolService.js';
import { convertWordToExcel } from '../../services/tools/documentToolService.js';
import { extractZipSafe } from '../../services/tools/zipToolService.js';
import { extractVideoImages } from '../../services/tools/videoImageToolService.js';

// Memory map of generated files for secure token-based download
// Map: downloadToken -> { filePath, fileName, mimeType, createdAt }
const downloadRegistry = new Map();

// Helper to schedule 10-minute cleanup for generated tool assets
function scheduleDirectoryCleanup(dirPath, delayMinutes = 10) {
  setTimeout(async () => {
    try {
      if (fs.existsSync(dirPath)) {
        await fs.promises.rm(dirPath, { recursive: true, force: true });
      }
    } catch (_) {}
  }, delayMinutes * 60 * 1000);
}

function registerDownload(filePath, customFileName = null) {
  const token = crypto.randomUUID();
  const fileName = customFileName || path.basename(filePath);
  downloadRegistry.set(token, {
    filePath,
    fileName,
    createdAt: Date.now()
  });

  // Auto remove registry entry after 15 minutes
  setTimeout(() => {
    downloadRegistry.delete(token);
  }, 15 * 60 * 1000);

  return {
    token,
    fileName,
    downloadUrl: `/api/tools/download/${token}/${encodeURIComponent(fileName)}`
  };
}

/**
 * 1. Image Size Reducer
 */
export async function handleImageReducer(req, res) {
  try {
    const files = req.files || (req.file ? [req.file] : []);
    if (files.length === 0) {
      return res.status(400).json({ error: 'No image files uploaded.' });
    }

    const { quality, targetSizeKB, maxWidth, maxHeight, format } = req.body;
    const toolRunId = `img_red_${crypto.randomUUID()}`;
    const outputDir = path.join(config.tempDir, 'tools', toolRunId);
    await fs.promises.mkdir(outputDir, { recursive: true });
    scheduleDirectoryCleanup(outputDir);

    const results = [];
    for (const f of files) {
      const resData = await reduceImageSize({
        filePath: f.path,
        outputDir,
        quality,
        targetSizeKB: targetSizeKB ? parseInt(targetSizeKB, 10) : null,
        maxWidth,
        maxHeight,
        outputFormat: format
      });

      const downloadInfo = registerDownload(resData.outputPath, resData.fileName);
      results.push({
        originalName: f.originalname,
        ...resData,
        ...downloadInfo
      });
    }

    // If multiple files, also generate a combined ZIP
    let zipDownload = null;
    if (results.length > 1) {
      const zipName = `compressed_images_${Date.now()}.zip`;
      const zipPath = path.join(outputDir, zipName);
      const outputStream = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 6 } });

      await new Promise((resolve, reject) => {
        outputStream.on('close', resolve);
        archive.on('error', reject);
        archive.pipe(outputStream);
        for (const item of results) {
          archive.file(item.outputPath, { name: item.fileName });
        }
        archive.finalize();
      });

      zipDownload = registerDownload(zipPath, zipName);
    }

    return res.json({
      success: true,
      count: results.length,
      results,
      zipDownload
    });
  } catch (err) {
    console.error('[Image Reducer Error]', err);
    return res.status(500).json({ error: err.message || 'Image reduction failed.' });
  }
}

/**
 * 2. Passport Size Photo Generator
 */
export async function handlePassportPhoto(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload a photo for the passport generator.' });
    }

    const { presetKey, customWidth, customHeight, bgColorKey, copiesOnA4 } = req.body;
    const toolRunId = `passport_${crypto.randomUUID()}`;
    const outputDir = path.join(config.tempDir, 'tools', toolRunId);
    await fs.promises.mkdir(outputDir, { recursive: true });
    scheduleDirectoryCleanup(outputDir);

    const generated = await generatePassportPhoto({
      filePath: req.file.path,
      outputDir,
      presetKey,
      customWidth,
      customHeight,
      bgColorKey,
      copiesOnA4
    });

    const singleDownload = registerDownload(generated.singlePhoto.filePath, generated.singlePhoto.fileName);
    const a4JpgDownload = registerDownload(generated.a4SheetJpg.filePath, generated.a4SheetJpg.fileName);
    const a4PdfDownload = registerDownload(generated.a4SheetPdf.filePath, generated.a4SheetPdf.fileName);

    return res.json({
      success: true,
      singlePhoto: {
        ...generated.singlePhoto,
        ...singleDownload
      },
      a4SheetJpg: {
        ...generated.a4SheetJpg,
        ...a4JpgDownload
      },
      a4SheetPdf: {
        ...generated.a4SheetPdf,
        ...a4PdfDownload
      }
    });
  } catch (err) {
    console.error('[Passport Photo Error]', err);
    return res.status(500).json({ error: err.message || 'Passport photo generation failed.' });
  }
}

/**
 * 3. PDF to Word Converter
 */
export async function handlePdfToWord(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload a PDF document.' });
    }

    const { enableOcr } = req.body;
    const toolRunId = `pdf_word_${crypto.randomUUID()}`;
    const outputDir = path.join(config.tempDir, 'tools', toolRunId);
    await fs.promises.mkdir(outputDir, { recursive: true });
    scheduleDirectoryCleanup(outputDir);

    const converted = await convertPdfToWord({
      filePath: req.file.path,
      outputDir,
      enableOcr: enableOcr === 'true' || enableOcr === true
    });

    const downloadInfo = registerDownload(converted.outputPath, converted.fileName);

    return res.json({
      success: true,
      ...converted,
      ...downloadInfo
    });
  } catch (err) {
    console.error('[PDF to Word Error]', err);
    return res.status(500).json({ error: err.message || 'PDF to Word conversion failed.' });
  }
}

/**
 * 4. Word to Excel Converter
 */
export async function handleWordToExcel(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload a Word (.docx/.doc) document.' });
    }

    const toolRunId = `word_excel_${crypto.randomUUID()}`;
    const outputDir = path.join(config.tempDir, 'tools', toolRunId);
    await fs.promises.mkdir(outputDir, { recursive: true });
    scheduleDirectoryCleanup(outputDir);

    const result = await convertWordToExcel({
      filePath: req.file.path,
      outputDir
    });

    const downloadInfo = registerDownload(result.outputPath, result.fileName);

    return res.json({
      success: true,
      ...result,
      ...downloadInfo
    });
  } catch (err) {
    console.error('[Word to Excel Error]', err);
    return res.status(500).json({ error: err.message || 'Word to Excel conversion failed.' });
  }
}

/**
 * 5. PDF to ZIP Converter
 */
export async function handlePdfToZip(req, res) {
  try {
    const files = req.files || (req.file ? [req.file] : []);
    if (files.length === 0) {
      return res.status(400).json({ error: 'Please upload at least one PDF file.' });
    }

    const { customZipName } = req.body;
    const toolRunId = `pdf_zip_${crypto.randomUUID()}`;
    const outputDir = path.join(config.tempDir, 'tools', toolRunId);
    await fs.promises.mkdir(outputDir, { recursive: true });
    scheduleDirectoryCleanup(outputDir);

    const result = await bundlePdfsToZip({
      files,
      outputDir,
      customZipName: customZipName || 'pdf_collection.zip'
    });

    const downloadInfo = registerDownload(result.outputPath, result.fileName);

    return res.json({
      success: true,
      ...result,
      ...downloadInfo
    });
  } catch (err) {
    console.error('[PDF to ZIP Error]', err);
    return res.status(500).json({ error: err.message || 'PDF to ZIP bundling failed.' });
  }
}

/**
 * 6. ZIP Extractor
 */
export async function handleZipExtractor(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload a ZIP file.' });
    }

    const toolRunId = `zip_ext_${crypto.randomUUID()}`;
    const extractionDir = path.join(config.tempDir, 'tools', toolRunId, 'extracted');
    await fs.promises.mkdir(extractionDir, { recursive: true });
    scheduleDirectoryCleanup(path.join(config.tempDir, 'tools', toolRunId));

    const extracted = await extractZipSafe({
      filePath: req.file.path,
      extractionDir
    });

    // Provide individual download links for extracted files
    const fileListWithDownloads = extracted.files.map((f) => {
      if (f.isDirectory) return f;
      const fullPath = path.join(extracted.extractionDir, f.relativePath);
      const dl = registerDownload(fullPath, f.name);
      return {
        ...f,
        downloadUrl: dl.downloadUrl,
        downloadToken: dl.token
      };
    });

    return res.json({
      success: true,
      totalFiles: extracted.totalFiles,
      totalFolders: extracted.totalFolders,
      totalUncompressedSize: extracted.totalUncompressedSize,
      files: fileListWithDownloads
    });
  } catch (err) {
    console.error('[ZIP Extractor Error]', err);
    return res.status(500).json({ error: err.message || 'ZIP extraction failed.' });
  }
}

/**
 * 7. Image Format Converter
 */
export async function handleImageConverter(req, res) {
  try {
    const files = req.files || (req.file ? [req.file] : []);
    if (files.length === 0) {
      return res.status(400).json({ error: 'No image files uploaded.' });
    }

    const { targetFormat, quality } = req.body;
    const toolRunId = `img_conv_${crypto.randomUUID()}`;
    const outputDir = path.join(config.tempDir, 'tools', toolRunId);
    await fs.promises.mkdir(outputDir, { recursive: true });
    scheduleDirectoryCleanup(outputDir);

    const results = [];
    for (const f of files) {
      const conv = await convertImageFormat({
        filePath: f.path,
        outputDir,
        targetFormat: targetFormat || 'webp',
        quality
      });

      const dl = registerDownload(conv.outputPath, conv.fileName);
      results.push({
        originalName: f.originalname,
        ...conv,
        ...dl
      });
    }

    let zipDownload = null;
    if (results.length > 1) {
      const zipName = `converted_images_${Date.now()}.zip`;
      const zipPath = path.join(outputDir, zipName);
      const outputStream = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 6 } });

      await new Promise((resolve, reject) => {
        outputStream.on('close', resolve);
        archive.on('error', reject);
        archive.pipe(outputStream);
        for (const item of results) {
          archive.file(item.outputPath, { name: item.fileName });
        }
        archive.finalize();
      });

      zipDownload = registerDownload(zipPath, zipName);
    }

    return res.json({
      success: true,
      count: results.length,
      results,
      zipDownload
    });
  } catch (err) {
    console.error('[Image Converter Error]', err);
    return res.status(500).json({ error: err.message || 'Image format conversion failed.' });
  }
}

/**
 * 8. Video to Image Converter
 */
export async function handleVideoToImage(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload a video file.' });
    }

    const { mode, timestamp, intervalSeconds, contactSheetCols } = req.body;
    const toolRunId = `vid_img_${crypto.randomUUID()}`;
    const outputDir = path.join(config.tempDir, 'tools', toolRunId);
    await fs.promises.mkdir(outputDir, { recursive: true });
    scheduleDirectoryCleanup(outputDir);

    const extracted = await extractVideoImages({
      filePath: req.file.path,
      outputDir,
      mode: mode || 'interval',
      timestamp: timestamp || '00:00:01',
      intervalSeconds,
      contactSheetCols
    });

    let singleDownload = null;
    if (extracted.singleImage) {
      singleDownload = registerDownload(extracted.singleImage.filePath, extracted.singleImage.fileName);
    }

    let zipDownload = null;
    if (extracted.zipArchive) {
      zipDownload = registerDownload(extracted.zipArchive.filePath, extracted.zipArchive.fileName);
    }

    return res.json({
      success: true,
      ...extracted,
      singleDownload,
      zipDownload
    });
  } catch (err) {
    console.error('[Video to Image Error]', err);
    return res.status(500).json({ error: err.message || 'Video frame extraction failed.' });
  }
}

/**
 * Secure Token-based File Downloader
 */
export async function handleToolDownload(req, res) {
  try {
    const { token, fileName } = req.params;
    const record = downloadRegistry.get(token);

    if (!record || !fs.existsSync(record.filePath)) {
      return res.status(404).json({ error: 'Requested file has expired or was not found. Please re-process your file.' });
    }

    const downloadName = fileName || record.fileName;
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(downloadName)}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    const fileStream = fs.createReadStream(record.filePath);
    fileStream.pipe(res);
  } catch (err) {
    console.error('[Tool Download Error]', err);
    return res.status(500).json({ error: 'Download failed.' });
  }
}


import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { PDFDocument } from 'pdf-lib';

/**
 * Image Size Reducer
 * Supports reducing file size to target KB or applying percentage quality.
 */
export async function reduceImageSize({
  filePath,
  outputDir,
  quality = 80,
  targetSizeKB = null,
  maxWidth = null,
  maxHeight = null,
  outputFormat = null
}) {
  const stat = await fs.promises.stat(filePath);
  const originalSize = stat.size;

  let image = sharp(filePath);
  const metadata = await image.metadata();

  // Resize dimensions if requested
  if (maxWidth || maxHeight) {
    image = image.resize({
      width: maxWidth ? parseInt(maxWidth, 10) : undefined,
      height: maxHeight ? parseInt(maxHeight, 10) : undefined,
      fit: 'inside',
      withoutEnlargement: true
    });
  }

  // Determine output format
  const ext = (outputFormat || metadata.format || 'jpeg').toLowerCase().replace('.', '');
  const validFormat = ['jpeg', 'jpg', 'png', 'webp'].includes(ext) ? (ext === 'jpg' ? 'jpeg' : ext) : 'jpeg';
  const fileName = `reduced_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.${validFormat === 'jpeg' ? 'jpg' : validFormat}`;
  const outputPath = path.join(outputDir, fileName);

  let currentQuality = Math.min(100, Math.max(10, parseInt(quality, 10) || 80));

  // If target size is specified, dynamically adjust quality to achieve target size
  if (targetSizeKB && targetSizeKB > 0) {
    const targetBytes = targetSizeKB * 1024;
    let minQ = 10;
    let maxQ = 95;
    let bestBuffer = null;

    for (let i = 0; i < 5; i++) {
      const testQ = Math.round((minQ + maxQ) / 2);
      let testPipeline = sharp(filePath);
      if (maxWidth || maxHeight) {
        testPipeline = testPipeline.resize({
          width: maxWidth ? parseInt(maxWidth, 10) : undefined,
          height: maxHeight ? parseInt(maxHeight, 10) : undefined,
          fit: 'inside',
          withoutEnlargement: true
        });
      }

      if (validFormat === 'png') {
        testPipeline = testPipeline.png({ quality: testQ, compressionLevel: 9 });
      } else if (validFormat === 'webp') {
        testPipeline = testPipeline.webp({ quality: testQ });
      } else {
        testPipeline = testPipeline.jpeg({ quality: testQ, mozjpeg: true });
      }

      const buf = await testPipeline.toBuffer();
      bestBuffer = buf;

      if (buf.length > targetBytes) {
        maxQ = testQ - 5;
      } else {
        minQ = testQ + 5;
      }
      if (minQ >= maxQ) break;
    }

    if (bestBuffer) {
      await fs.promises.writeFile(outputPath, bestBuffer);
    }
  } else {
    // Standard quality reduction
    if (validFormat === 'png') {
      await image.png({ quality: currentQuality, compressionLevel: 9 }).toFile(outputPath);
    } else if (validFormat === 'webp') {
      await image.webp({ quality: currentQuality }).toFile(outputPath);
    } else {
      await image.jpeg({ quality: currentQuality, mozjpeg: true }).toFile(outputPath);
    }
  }

  const outStat = await fs.promises.stat(outputPath);
  const outMetadata = await sharp(outputPath).metadata();
  const savedBytes = Math.max(0, originalSize - outStat.size);
  const percentSaved = Math.round((savedBytes / originalSize) * 100);

  return {
    outputPath,
    fileName,
    originalSize,
    compressedSize: outStat.size,
    savedBytes,
    percentSaved,
    width: outMetadata.width,
    height: outMetadata.height,
    format: validFormat
  };
}

/**
 * Passport Photo Generator Presets (Dimensions in pixels at 300 DPI)
 */
export const PASSPORT_PRESETS = {
  indian: { name: 'Indian Passport (35 x 45 mm)', width: 413, height: 531, mmW: 35, mmH: 45 },
  us: { name: 'US / International (2 x 2 inch / 51 x 51 mm)', width: 600, height: 600, mmW: 51, mmH: 51 },
  square: { name: 'Square Photo (35 x 35 mm)', width: 413, height: 413, mmW: 35, mmH: 35 },
  custom: { name: 'Custom Dimensions', width: 413, height: 531, mmW: 35, mmH: 45 }
};

export const PASSPORT_BG_COLORS = {
  white: '#FFFFFF',
  blue: '#3B82F6',
  light_blue: '#E0F2FE',
  light_grey: '#E2E8F0',
  transparent: null
};

/**
 * Generates single passport photo and tiled A4 printable sheet (JPG and PDF).
 */
export async function generatePassportPhoto({
  filePath,
  outputDir,
  presetKey = 'indian',
  customWidth = null,
  customHeight = null,
  bgColorKey = 'white',
  copiesOnA4 = 8 // 8, 16, or 32
}) {
  const preset = PASSPORT_PRESETS[presetKey] || PASSPORT_PRESETS.indian;
  const pWidth = customWidth ? parseInt(customWidth, 10) : preset.width;
  const pHeight = customHeight ? parseInt(customHeight, 10) : preset.height;

  const hexBg = PASSPORT_BG_COLORS[bgColorKey] || '#FFFFFF';

  // 1. Crop and resize photo to exact passport aspect ratio & dimensions
  let photoPipeline = sharp(filePath)
    .resize(pWidth, pHeight, {
      fit: 'cover',
      position: 'center'
    });

  if (hexBg) {
    photoPipeline = photoPipeline.flatten({ background: hexBg });
  }

  const singlePhotoBuffer = await photoPipeline.jpeg({ quality: 95 }).toBuffer();
  const runId = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const singlePhotoFileName = `passport_single_${runId}.jpg`;
  const singlePhotoPath = path.join(outputDir, singlePhotoFileName);
  await fs.promises.writeFile(singlePhotoPath, singlePhotoBuffer);

  // 2. Generate A4 Printable Sheet (A4 at 300 DPI = 2480 x 3508 pixels)
  const a4Width = 2480;
  const a4Height = 3508;
  const copies = Math.min(32, Math.max(1, parseInt(copiesOnA4, 10) || 8));

  // Determine grid columns & rows based on copies
  let cols = 4;
  let rows = 2;
  if (copies > 16) {
    cols = 4;
    rows = 8;
  } else if (copies > 8) {
    cols = 4;
    rows = 4;
  } else if (copies <= 4) {
    cols = 2;
    rows = 2;
  }

  // Cell dimensions with margins
  const horizontalPadding = 120;
  const verticalPadding = 160;
  const availableW = a4Width - horizontalPadding * 2;
  const availableH = a4Height - verticalPadding * 2;
  const cellW = Math.floor(availableW / cols);
  const cellH = Math.floor(availableH / rows);

  // Add 1px border around each passport photo for easy cutting
  const borderedPhotoBuffer = await sharp(singlePhotoBuffer)
    .extend({
      top: 2,
      bottom: 2,
      left: 2,
      right: 2,
      background: '#94A3B8' // light slate border
    })
    .toBuffer();

  const composites = [];
  let count = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (count >= copies) break;
      const x = horizontalPadding + c * cellW + Math.floor((cellW - pWidth) / 2);
      const y = verticalPadding + r * cellH + Math.floor((cellH - pHeight) / 2);

      composites.push({
        input: borderedPhotoBuffer,
        top: Math.max(0, y),
        left: Math.max(0, x)
      });
      count++;
    }
    if (count >= copies) break;
  }

  // Create A4 canvas with white background
  const a4SheetBuffer = await sharp({
    create: {
      width: a4Width,
      height: a4Height,
      channels: 3,
      background: '#FFFFFF'
    }
  })
    .composite(composites)
    .jpeg({ quality: 95 })
    .toBuffer();

  const a4FileName = `passport_a4_sheet_${runId}.jpg`;
  const a4FilePath = path.join(outputDir, a4FileName);
  await fs.promises.writeFile(a4FilePath, a4SheetBuffer);

  // 3. Generate Printable PDF from A4 sheet
  const pdfDoc = await PDFDocument.create();
  const pdfPage = pdfDoc.addPage([595.28, 841.89]); // A4 in standard points (72 DPI)
  const embeddedImage = await pdfDoc.embedJpg(a4SheetBuffer);
  pdfPage.drawImage(embeddedImage, {
    x: 0,
    y: 0,
    width: 595.28,
    height: 841.89
  });

  const pdfBytes = await pdfDoc.save();
  const pdfFileName = `passport_a4_sheet_${runId}.pdf`;
  const pdfFilePath = path.join(outputDir, pdfFileName);
  await fs.promises.writeFile(pdfFilePath, pdfBytes);

  return {
    singlePhoto: {
      fileName: singlePhotoFileName,
      filePath: singlePhotoPath,
      width: pWidth,
      height: pHeight
    },
    a4SheetJpg: {
      fileName: a4FileName,
      filePath: a4FilePath,
      copies
    },
    a4SheetPdf: {
      fileName: pdfFileName,
      filePath: pdfFilePath
    }
  };
}

/**
 * Image Format Converter
 * Converts between JPG, PNG, WEBP, GIF, BMP, TIFF, AVIF.
 */
export async function convertImageFormat({
  filePath,
  outputDir,
  targetFormat = 'webp',
  quality = 85
}) {
  const stat = await fs.promises.stat(filePath);
  const originalSize = stat.size;

  const validFormats = ['jpeg', 'jpg', 'png', 'webp', 'gif', 'tiff', 'avif'];
  let fmt = targetFormat.toLowerCase().replace('.', '');
  if (fmt === 'jpg') fmt = 'jpeg';
  if (!validFormats.includes(fmt)) fmt = 'webp';

  const ext = fmt === 'jpeg' ? 'jpg' : fmt;
  const fileName = `converted_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.${ext}`;
  const outputPath = path.join(outputDir, fileName);

  const q = Math.min(100, Math.max(10, parseInt(quality, 10) || 85));
  let pipeline = sharp(filePath);

  switch (fmt) {
    case 'jpeg':
      pipeline = pipeline.jpeg({ quality: q, mozjpeg: true });
      break;
    case 'png':
      pipeline = pipeline.png({ quality: q, compressionLevel: 8 });
      break;
    case 'webp':
      pipeline = pipeline.webp({ quality: q });
      break;
    case 'gif':
      pipeline = pipeline.gif();
      break;
    case 'tiff':
      pipeline = pipeline.tiff({ quality: q });
      break;
    case 'avif':
      pipeline = pipeline.avif({ quality: q });
      break;
    default:
      pipeline = pipeline.webp({ quality: q });
  }

  await pipeline.toFile(outputPath);

  const outStat = await fs.promises.stat(outputPath);
  const outMetadata = await sharp(outputPath).metadata();

  return {
    outputPath,
    fileName,
    originalSize,
    convertedSize: outStat.size,
    format: ext,
    width: outMetadata.width,
    height: outMetadata.height
  };
}


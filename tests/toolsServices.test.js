import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { Document, Paragraph, Table, TableRow, TableCell, Packer } from 'docx';
import AdmZip from 'adm-zip';

import { reduceImageSize, generatePassportPhoto, convertImageFormat } from '../src/services/tools/imageToolService.js';
import { convertPdfToWord, bundlePdfsToZip } from '../src/services/tools/pdfToolService.js';
import { convertWordToExcel } from '../src/services/tools/documentToolService.js';
import { extractZipSafe } from '../src/services/tools/zipToolService.js';
import { extractVideoImages } from '../src/services/tools/videoImageToolService.js';
import { config } from '../src/config/env.js';
import { spawn } from 'child_process';

test('New File Utility Tools Services Suite', async (t) => {
  const testDir = path.join(os.tmpdir(), `test_tools_${Date.now()}`);
  await fs.promises.mkdir(testDir, { recursive: true });

  await t.test('1. Image Size Reducer shrinks image bytes and resizes', async () => {
    const inputPath = path.join(testDir, 'large.jpg');
    // Create synthetic 1000x1000 image
    await sharp({
      create: {
        width: 1000,
        height: 1000,
        channels: 3,
        background: { r: 100, g: 150, b: 200 }
      }
    }).jpeg({ quality: 95 }).toFile(inputPath);

    const initialStat = await fs.promises.stat(inputPath);

    const result = await reduceImageSize({
      filePath: inputPath,
      outputDir: testDir,
      quality: 40,
      maxWidth: 500,
      maxHeight: 500
    });

    assert.ok(fs.existsSync(result.outputPath));
    assert.strictEqual(result.width, 500);
    assert.strictEqual(result.height, 500);
    assert.ok(result.compressedSize < initialStat.size);
    assert.ok(result.percentSaved > 0);
  });

  await t.test('2. Passport Photo Generator produces valid cropped photo, A4 JPEG and PDF', async () => {
    const inputPath = path.join(testDir, 'portrait.jpg');
    await sharp({
      create: {
        width: 600,
        height: 800,
        channels: 3,
        background: { r: 230, g: 200, b: 180 }
      }
    }).jpeg().toFile(inputPath);

    const result = await generatePassportPhoto({
      filePath: inputPath,
      outputDir: testDir,
      presetKey: 'indian',
      bgColorKey: 'white',
      copiesOnA4: 8
    });

    assert.ok(fs.existsSync(result.singlePhoto.filePath));
    assert.ok(fs.existsSync(result.a4SheetJpg.filePath));
    assert.ok(fs.existsSync(result.a4SheetPdf.filePath));
    assert.strictEqual(result.a4SheetPdf.fileName.endsWith('.pdf'), true);
  });

  await t.test('3. Image Format Converter converts between JPG, WebP, and PNG', async () => {
    const inputPath = path.join(testDir, 'source.png');
    await sharp({
      create: {
        width: 200,
        height: 200,
        channels: 4,
        background: { r: 50, g: 100, b: 200, alpha: 0.8 }
      }
    }).png().toFile(inputPath);

    const result = await convertImageFormat({
      filePath: inputPath,
      outputDir: testDir,
      targetFormat: 'webp',
      quality: 80
    });

    assert.ok(fs.existsSync(result.outputPath));
    assert.strictEqual(result.format, 'webp');
  });

  await t.test('4. PDF to ZIP Bundler packages multiple PDFs without alteration', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([300, 400]);
    const pdfBytes = await pdfDoc.save();

    const pdf1 = path.join(testDir, 'doc1.pdf');
    const pdf2 = path.join(testDir, 'doc2.pdf');
    await fs.promises.writeFile(pdf1, pdfBytes);
    await fs.promises.writeFile(pdf2, pdfBytes);

    const zipResult = await bundlePdfsToZip({
      files: [
        { path: pdf1, originalname: 'doc1.pdf' },
        { path: pdf2, originalname: 'doc2.pdf' }
      ],
      outputDir: testDir,
      customZipName: 'my_pdfs.zip'
    });

    assert.ok(fs.existsSync(zipResult.outputPath));
    const zip = new AdmZip(zipResult.outputPath);
    const entries = zip.getEntries().map(e => e.entryName);
    assert.ok(entries.includes('doc1.pdf'));
    assert.ok(entries.includes('doc2.pdf'));
  });

  await t.test('5. ZIP Extractor safely extracts files and folder structures', async () => {
    const safeZipPath = path.join(testDir, 'safe.zip');
    const zip = new AdmZip();
    zip.addFile('notes.txt', Buffer.from('Important notes'));
    zip.addFile('subfolder/data.json', Buffer.from('{"key":"value"}'));
    zip.writeZip(safeZipPath);

    const extractDir = path.join(testDir, 'extracted');
    const res = await extractZipSafe({
      filePath: safeZipPath,
      extractionDir: extractDir
    });

    assert.strictEqual(res.totalFiles, 2);
    assert.ok(fs.existsSync(path.join(extractDir, 'notes.txt')));
    assert.ok(fs.existsSync(path.join(extractDir, 'subfolder', 'data.json')));
  });

  await t.test('6. Word to Excel Converter parses tables into formatted XLSX', async () => {
    const docPath = path.join(testDir, 'table.docx');
    const doc = new Document({
      sections: [{
        children: [
          new Paragraph('Employee Report Table'),
          new Table({
            rows: [
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph('ID')] }),
                  new TableCell({ children: [new Paragraph('Name')] }),
                  new TableCell({ children: [new Paragraph('Department')] })
                ]
              }),
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph('101')] }),
                  new TableCell({ children: [new Paragraph('Alice')] }),
                  new TableCell({ children: [new Paragraph('Engineering')] })
                ]
              }),
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph('102')] }),
                  new TableCell({ children: [new Paragraph('Bob')] }),
                  new TableCell({ children: [new Paragraph('Design')] })
                ]
              })
            ]
          })
        ]
      }]
    });

    const buffer = await Packer.toBuffer(doc);
    await fs.promises.writeFile(docPath, buffer);

    const excelResult = await convertWordToExcel({
      filePath: docPath,
      outputDir: testDir
    });

    assert.ok(fs.existsSync(excelResult.outputPath));
    assert.strictEqual(excelResult.tablesCount, 1);
    assert.ok(excelResult.tablesPreview[0].rows.length >= 3);
  });

  await t.test('7. PDF to DOCX Converter converts text pages into Word', async () => {
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([500, 600]);
    page.drawText('Sample PDF content for conversion to docx', { x: 50, y: 500, size: 14 });
    const pdfBytes = await pdfDoc.save();

    const pdfPath = path.join(testDir, 'simple.pdf');
    await fs.promises.writeFile(pdfPath, pdfBytes);

    const docxResult = await convertPdfToWord({
      filePath: pdfPath,
      outputDir: testDir,
      enableOcr: false
    });

    assert.ok(fs.existsSync(docxResult.outputPath));
    assert.strictEqual(docxResult.fileName.endsWith('.docx'), true);
  });

  await t.test('8. Video to Image Converter extracts frames and contact sheet', async () => {
    const videoPath = path.join(testDir, 'synthetic.mp4');
    // Generate 2-second synthetic video using ffmpeg
    await new Promise((resolve, reject) => {
      const proc = spawn(config.ffmpegPath, [
        '-y',
        '-f', 'lavfi',
        '-i', 'testsrc=duration=2:size=320x240:rate=10',
        '-c:v', 'libx264',
        videoPath
      ], { windowsHide: true });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg exited with code ${code}`));
      });
    });

    assert.ok(fs.existsSync(videoPath));

    // Test interval frame extraction
    const intervalResult = await extractVideoImages({
      filePath: videoPath,
      outputDir: testDir,
      mode: 'interval',
      intervalSeconds: 1
    });

    assert.strictEqual(intervalResult.mode, 'interval');
    assert.ok(intervalResult.totalFrames >= 1);
    assert.ok(fs.existsSync(intervalResult.zipArchive.filePath));

    // Test single timestamp frame
    const timestampResult = await extractVideoImages({
      filePath: videoPath,
      outputDir: testDir,
      mode: 'timestamp',
      timestamp: '00:00:01'
    });

    assert.strictEqual(timestampResult.mode, 'timestamp');
    assert.ok(fs.existsSync(timestampResult.singleImage.filePath));
  });

  // Cleanup test directory
  try {
    await fs.promises.rm(testDir, { recursive: true, force: true });
  } catch (_) {}
});

import fs from 'fs';
import path from 'path';
import { PDFParse } from 'pdf-parse';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import archiver from 'archiver';
import { PDFDocument } from 'pdf-lib';

/**
 * PDF to Word Converter
 * Extracts text, layout, headers, paragraphs, and creates editable DOCX.
 * Supports optional OCR for scanned documents.
 */
export async function convertPdfToWord({
  filePath,
  outputDir,
  enableOcr = false,
  onProgress = null
}) {
  const dataBuffer = await fs.promises.readFile(filePath);
  if (onProgress) onProgress(15, 'Parsing PDF document structure');

  let textContent = '';
  let numPages = 1;

  try {
    const parser = new PDFParse({ data: dataBuffer });
    const textResult = await parser.getText();
    textContent = textResult.text || '';
    numPages = textResult.total || 1;
    if (typeof parser.destroy === 'function') {
      await parser.destroy();
    }
  } catch (err) {
    console.warn('[PDF Parse Warning]', err.message);
  }

  // If text is virtually empty and OCR is requested, fallback to OCR
  if ((!textContent || textContent.trim().length < 50) && enableOcr) {
    if (onProgress) onProgress(35, 'Performing Optical Character Recognition (OCR)');
    try {
      const { createWorker } = await import('tesseract.js');
      const worker = await createWorker('eng');
      // For basic OCR if scanned image in PDF
      const ret = await worker.recognize(dataBuffer);
      textContent = ret.data.text;
      await worker.terminate();
    } catch (ocrErr) {
      console.warn('[OCR Warning]', ocrErr.message);
    }
  }

  if (onProgress) onProgress(60, 'Generating editable Word (.docx) document');

  // Split text into paragraphs and detect potential headings
  const lines = textContent.split(/\r?\n/);
  const docParagraphs = [];

  for (let line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      // Empty line / paragraph break
      docParagraphs.push(new Paragraph({ text: '' }));
      continue;
    }

    // Heuristic: Short lines (< 60 chars) with no period at end are likely headings
    const isHeading = trimmed.length < 55 && !trimmed.endsWith('.') && /^[A-Z0-9\s:_-]+$/i.test(trimmed);

    if (isHeading) {
      docParagraphs.push(
        new Paragraph({
          text: trimmed,
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 200, after: 100 }
        })
      );
    } else {
      docParagraphs.push(
        new Paragraph({
          children: [
            new TextRun({
              text: trimmed,
              size: 24 // 12pt in half-points
            })
          ],
          spacing: { after: 120 }
        })
      );
    }
  }

  if (docParagraphs.length === 0) {
    docParagraphs.push(new Paragraph({ text: 'No extractable text found in source PDF.' }));
  }

  // Create DOCX Document
  const doc = new Document({
    sections: [
      {
        properties: {},
        children: docParagraphs
      }
    ]
  });

  const runId = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const fileName = `converted_${runId}.docx`;
  const outputPath = path.join(outputDir, fileName);

  const docBuffer = await Packer.toBuffer(doc);
  await fs.promises.writeFile(outputPath, docBuffer);

  if (onProgress) onProgress(100, 'Conversion completed');

  const stat = await fs.promises.stat(outputPath);

  return {
    outputPath,
    fileName,
    fileSize: stat.size,
    pagesProcessed: numPages,
    paragraphsCount: docParagraphs.length
  };
}

/**
 * PDF to ZIP Converter
 * Bundles multiple uploaded PDFs into a ZIP archive without altering quality.
 */
export async function bundlePdfsToZip({
  files,
  outputDir,
  customZipName = 'pdf_archive.zip'
}) {
  const safeName = (customZipName.endsWith('.zip') ? customZipName : `${customZipName}.zip`).replace(/[\\/:*?"<>|]/g, '_');
  const runId = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const fileName = `${path.parse(safeName).name}_${runId}.zip`;
  const outputPath = path.join(outputDir, fileName);

  const outputStream = fs.createWriteStream(outputPath);
  const archive = archiver('zip', { zlib: { level: 6 } });

  return new Promise((resolve, reject) => {
    outputStream.on('close', async () => {
      const stat = await fs.promises.stat(outputPath);
      resolve({
        outputPath,
        fileName,
        fileSize: stat.size,
        filesCount: files.length
      });
    });

    archive.on('error', (err) => reject(err));
    archive.pipe(outputStream);

    for (const f of files) {
      archive.file(f.filePath || f.path, { name: f.originalName || f.originalname || path.basename(f.filePath || f.path) });
    }

    archive.finalize();
  });
}

export { convertPdfToWord as convertPdfToDocx };

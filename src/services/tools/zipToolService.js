import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';

const MAX_ZIP_ENTRIES = 1000;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

/**
 * ZIP Extractor with strict ZIP Slip protection & ZIP Bomb safeguards.
 */
export async function extractZipSafe({
  filePath,
  extractionDir
}) {
  const zip = new AdmZip(filePath);
  const zipEntries = zip.getEntries();

  if (zipEntries.length > MAX_ZIP_ENTRIES) {
    throw new Error(`ZIP contains too many files (${zipEntries.length}). Maximum allowed is ${MAX_ZIP_ENTRIES}.`);
  }

  let totalUncompressedSize = 0;
  const inspectedFiles = [];
  const normalizedExtractDir = path.resolve(extractionDir);

  if (!fs.existsSync(normalizedExtractDir)) {
    await fs.promises.mkdir(normalizedExtractDir, { recursive: true });
  }

  // 1. First pass: Inspect all entries and validate safety
  for (const entry of zipEntries) {
    totalUncompressedSize += entry.header.size;

    if (totalUncompressedSize > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error('Uncompressed ZIP size exceeds the 2 GB security limit (Potential ZIP Bomb).');
    }

    // ZIP Slip Prevention: Target path MUST stay strictly inside normalizedExtractDir
    const targetPath = path.resolve(normalizedExtractDir, entry.entryName);
    if (!targetPath.startsWith(normalizedExtractDir)) {
      throw new Error(`Malicious path traversal detected in ZIP entry: ${entry.entryName}`);
    }

    const ext = path.extname(entry.entryName).toLowerCase();
    inspectedFiles.push({
      name: path.basename(entry.entryName),
      relativePath: entry.entryName,
      isDirectory: entry.isDirectory,
      size: entry.header.size,
      compressedSize: entry.header.compressedSize,
      extension: ext || (entry.isDirectory ? 'folder' : 'unknown')
    });
  }

  // 2. Second pass: Safe extraction
  for (const entry of zipEntries) {
    const targetPath = path.resolve(normalizedExtractDir, entry.entryName);

    if (entry.isDirectory) {
      if (!fs.existsSync(targetPath)) {
        await fs.promises.mkdir(targetPath, { recursive: true });
      }
    } else {
      const parentDir = path.dirname(targetPath);
      if (!fs.existsSync(parentDir)) {
        await fs.promises.mkdir(parentDir, { recursive: true });
      }

      const contentBuffer = entry.getData();
      await fs.promises.writeFile(targetPath, contentBuffer);
    }
  }

  return {
    extractionDir: normalizedExtractDir,
    totalFiles: inspectedFiles.filter(f => !f.isDirectory).length,
    totalFolders: inspectedFiles.filter(f => f.isDirectory).length,
    totalUncompressedSize,
    files: inspectedFiles
  };
}


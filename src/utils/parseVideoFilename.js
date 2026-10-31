import path from 'path';

export const SUPPORTED_EXTENSIONS = new Set([
  '.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.ts', '.flv', '.wmv', '.3gp'
]);

/**
 * Checks if a file has a supported video extension.
 * @param {string} filename 
 * @returns {boolean}
 */
export function isSupportedVideoFile(filename) {
  if (!filename) return false;
  const ext = path.extname(filename).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

/**
 * Helper to extract explicit part numbers from text.
 * Looks for keyword indicators (part, pt, episode, ep, lesson, clip, cd) or trailing numbers.
 * @param {string} text
 * @returns {number | null}
 */
function extractPartFromText(text) {
  if (!text) return null;

  // 1. Keyword-based part indicator: Part, Pt, Episode, Ep, Lesson, Clip, CD followed by number
  // Supports: "part 1", "Part 2", "pt 3", "ep 4", "lesson 5", "part_10", "(Part 6)", "part_2_duplicate"
  const keywordRegex = /(?:^|[\s._-]+|\s*[\(\[\{]\s*)(?:part|pt|episode|ep|lesson|clip|cd)\s*[\s._-]?\s*(\d+)(?:[\s\)\]\}._-].*)?$/i;
  const kwMatch = text.match(keywordRegex);
  if (kwMatch) {
    const num = parseInt(kwMatch[1], 10);
    if (!isNaN(num) && num > 0) return num;
  }

  // 2. Trailing delimiter + number at the very end: e.g. "- 2", "_ 3", "(4)", "[5]"
  const trailingDelimiterNumRegex = /(?:[\s_-]+|\s*[\(\[\{]\s*)(\d+)[\s\)\]\}]*$/;
  const trailMatch = text.match(trailingDelimiterNumRegex);
  if (trailMatch) {
    const num = parseInt(trailMatch[1], 10);
    if (!isNaN(num) && num > 0) return num;
  }

  return null;
}

/**
 * Parses a video filename to extract seriesId, partNumber, and recognition status.
 * 
 * Rules:
 * 1. Extract base filename without directory and extension.
 * 2. Primary check: Extract the series ID from the beginning of the filename (e.g., '5.1.3', '5.1.1', '5.1.10').
 *    Never mix different series IDs (e.g. '5.1.3' and '5.1.30').
 * 3. Support arbitrary lesson titles between series ID and part indicator:
 *    - '5.1.3 component composition part 1.mp4' -> Series 5.1.3, Part 1
 *    - '5.1.3 component composition part 2.mp4' -> Series 5.1.3, Part 2
 *    - '5.1.3 conditional rendering.mp4' -> Series 5.1.3, Part 1 (no explicit part defaults to Part 1)
 *    - '5.1.3 useState local component state part 3.mp4' -> Series 5.1.3, Part 3
 * 4. Lesson-title differences are ignored when grouping: all files with the same exact leading series ID
 *    belong to the same series.
 * 5. Fallback for non-hierarchical filenames with explicit parts (e.g. 'Tamil Lección 1.2 - Part 3.mp4').
 * 6. Completely ambiguous filenames without series pattern are marked isRecognized = false for manual workflow.
 * 
 * @param {string} filenameOrPath 
 * @returns {{
 *   originalName: string,
 *   baseName: string,
 *   extension: string,
 *   seriesId: string,
 *   partNumber: number,
 *   hasExplicitPart: boolean,
 *   isRecognized: boolean,
 *   warning: string | null
 * }}
 */
export function parseVideoFilename(filenameOrPath) {
  if (!filenameOrPath || typeof filenameOrPath !== 'string') {
    return {
      originalName: '',
      baseName: '',
      extension: '',
      seriesId: 'Unrecognized',
      partNumber: 1,
      hasExplicitPart: false,
      isRecognized: false,
      warning: 'Invalid filename provided.'
    };
  }

  // Normalize path separators and get basename
  const sanitizedPath = filenameOrPath.replace(/\\/g, '/');
  const originalName = path.basename(sanitizedPath);
  const extension = path.extname(originalName).toLowerCase();
  const nameWithoutExt = originalName.slice(0, originalName.length - extension.length).trim();

  if (!isSupportedVideoFile(originalName)) {
    return {
      originalName,
      baseName: nameWithoutExt,
      extension,
      seriesId: 'Unrecognized',
      partNumber: 1,
      hasExplicitPart: false,
      isRecognized: false,
      warning: `Unsupported file extension (${extension || 'none'}). Supported: ${Array.from(SUPPORTED_EXTENSIONS).join(', ')}`
    };
  }

  // Rule 1: Extract series ID from the beginning of the filename (e.g. "5.1.3", "5.1.1", "5.1.10", "1.2")
  // Boundary check ensures 5.1.3 is not matched as a prefix of 5.1.30.
  const leadingSeriesRegex = /^(?:(?:chapter|lesson|sec|section|module|unit|ep|episode)\s+)?(\d+(?:\.\d+)+)(?=$|[\s._\-\(\[\{])/i;
  const leadingMatch = nameWithoutExt.match(leadingSeriesRegex);

  if (leadingMatch) {
    const seriesId = leadingMatch[1];
    const afterSeries = nameWithoutExt.slice(leadingMatch[0].length);
    const cleanRemaining = afterSeries.replace(/^[\s._\-]+/, '').trim();

    // Check for explicit part indicator in remaining text (ignoring arbitrary lesson titles)
    const explicitPart = extractPartFromText(cleanRemaining);

    return {
      originalName,
      baseName: nameWithoutExt,
      extension,
      seriesId,
      // Rule 3 & 4: If explicit Part N exists, use it; otherwise automatically assign Part 1
      partNumber: explicitPart !== null ? explicitPart : 1,
      hasExplicitPart: explicitPart !== null,
      isRecognized: true,
      warning: null
    };
  }

  // Fallback: Check if filename contains explicit part marker elsewhere in non-hierarchical filenames
  // E.g. "Tamil Lección 1.2 - Part 3", "Video Series - Part 2"
  const explicitPartRegexes = [
    /^(.*?)(?:[\s._-]+|\s*[\(\[\{]\s*)(?:part|pt|episode|ep|lesson|clip|cd)\s*[\s._-]?\s*(\d+)(?:[\s\)\]\}._-].*)?$/i,
    /^(.*?)(?:part|pt|episode|ep|lesson|clip|cd)\s*(\d+)(?:[\s\)\]\}._-].*)?$/i,
    /^(.*?)[\s_-]+(\d+)[\s\)\]\}]*$/i
  ];

  for (const regex of explicitPartRegexes) {
    const match = nameWithoutExt.match(regex);
    if (match) {
      const candidateSeries = match[1].replace(/[\s._-]+$/, '').trim();
      const candidatePart = parseInt(match[2], 10);
      
      if (candidateSeries && !isNaN(candidatePart) && candidatePart > 0) {
        const cleanSeriesId = candidateSeries
          .replace(/[\(\[\{]+$/, '')
          .replace(/^[\(\[\{]+/, '')
          .trim();

        return {
          originalName,
          baseName: nameWithoutExt,
          extension,
          seriesId: cleanSeriesId || 'Series 1',
          partNumber: candidatePart,
          hasExplicitPart: true,
          isRecognized: true,
          warning: null
        };
      }
    }
  }

  // Fallback for single integer title like "Lesson 5" or "Video 2"
  const genericNumberedRegex = /^(?:(?:chapter|lesson|video|sec|section|module|unit|ep|episode)\s+)(\d+)$/i;
  const genericMatch = nameWithoutExt.match(genericNumberedRegex);
  if (genericMatch) {
    return {
      originalName,
      baseName: nameWithoutExt,
      extension,
      seriesId: nameWithoutExt,
      partNumber: 1,
      hasExplicitPart: false,
      isRecognized: true,
      warning: null
    };
  }

  // Rule 10: If a filename cannot be parsed confidently, keep it in the unrecognized-files workflow
  return {
    originalName,
    baseName: nameWithoutExt,
    extension,
    seriesId: 'Unrecognized',
    partNumber: 1,
    hasExplicitPart: false,
    isRecognized: false,
    warning: 'Could not confidently detect series identifier. Please assign manually.'
  };
}

/**
 * Groups an array of video file metadata into organized series with numerical part ordering,
 * duplicate detection, and missing Part 1 validation.
 * 
 * @param {Array<Object>} files Array of file objects containing at least { id, originalName }
 * @returns {{
 *   groups: Array<{
 *     seriesId: string,
 *     parts: Array<Object>,
 *     totalParts: number,
 *     totalSize: number,
 *     warnings: Array<string>,
 *     isReadyForMerge: boolean
 *   }>,
 *   unrecognized: Array<Object>,
 *   summary: {
 *     totalFiles: number,
 *     totalSeries: number,
 *     readySeries: number,
 *     seriesWithWarnings: number,
 *     unrecognizedCount: number
 *   }
 * }}
 */
export function groupVideoFiles(files = []) {
  const groupsMap = new Map();
  const unrecognized = [];

  for (const file of files) {
    const raw = (file && typeof file.toObject === 'function') ? file.toObject() : (file || {});
    const fileId = raw._id ? raw._id.toString() : (raw.id ? String(raw.id) : '');

    // If file already has manual overrides applied, respect them; otherwise parse originalName
    const parsed = (raw.seriesId && raw.partNumber)
      ? {
          seriesId: String(raw.seriesId).trim(),
          partNumber: Number(raw.partNumber) || 1,
          isRecognized: raw.isRecognized !== false,
          warning: raw.warning || null
        }
      : parseVideoFilename(raw.originalName || raw.filename || '');

    const enrichedFile = {
      ...raw,
      _id: fileId,
      id: fileId,
      seriesId: parsed.seriesId,
      partNumber: parsed.partNumber,
      isRecognized: parsed.isRecognized,
      detectedWarning: parsed.warning
    };

    if (!parsed.isRecognized && parsed.seriesId === 'Unrecognized') {
      unrecognized.push(enrichedFile);
      continue;
    }

    if (!groupsMap.has(parsed.seriesId)) {
      groupsMap.set(parsed.seriesId, []);
    }
    groupsMap.get(parsed.seriesId).push(enrichedFile);
  }

  const groups = [];

  for (const [seriesId, seriesFiles] of groupsMap.entries()) {
    // 1. Sort parts strictly numerically, NEVER alphabetically!
    // Ensures Part 2 is before Part 10.
    seriesFiles.sort((a, b) => a.partNumber - b.partNumber);

    const warnings = [];
    const partNumberCounts = new Map();
    let minPart = Infinity;
    let maxPart = -Infinity;
    let hasPart1 = false;
    let totalSize = 0;

    for (const f of seriesFiles) {
      totalSize += (Number(f.fileSize || f.size) || 0);
      const p = f.partNumber;
      if (p < minPart) minPart = p;
      if (p > maxPart) maxPart = p;
      if (p === 1) hasPart1 = true;

      partNumberCounts.set(p, (partNumberCounts.get(p) || 0) + 1);
    }

    // Check for duplicate part numbers
    for (const [pNum, count] of partNumberCounts.entries()) {
      if (count > 1) {
        warnings.push(`Duplicate Part ${pNum} detected: ${count} files have the same part number.`);
      }
    }

    // Check for missing Part 1 if this is a multi-part series or starts with part > 1
    if (!hasPart1) {
      warnings.push(`Missing Part 1. Earliest detected part is Part ${minPart}.`);
    }

    // Check for missing intermediate sequence parts
    if (seriesFiles.length > 1 && maxPart > minPart) {
      const missingParts = [];
      for (let i = minPart; i <= maxPart; i++) {
        if (!partNumberCounts.has(i)) {
          missingParts.push(i);
        }
      }
      if (missingParts.length > 0) {
        warnings.push(`Sequence gap detected: Part(s) ${missingParts.join(', ')} are missing.`);
      }
    }

    groups.push({
      seriesId,
      parts: seriesFiles,
      totalParts: seriesFiles.length,
      totalSize,
      warnings,
      isReadyForMerge: warnings.length === 0
    });
  }

  // Sort groups naturally by seriesId
  groups.sort((a, b) => a.seriesId.localeCompare(b.seriesId, undefined, { numeric: true, sensitivity: 'base' }));

  const readySeries = groups.filter(g => g.isReadyForMerge).length;
  const seriesWithWarnings = groups.length - readySeries;

  return {
    groups,
    unrecognized,
    summary: {
      totalFiles: files.length,
      totalSeries: groups.length,
      readySeries,
      seriesWithWarnings,
      unrecognizedCount: unrecognized.length
    }
  };
}

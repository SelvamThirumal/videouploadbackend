import fs from 'fs';
import path from 'path';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';

/**
 * Word to Excel Converter
 * Parses tables and tabular data from DOCX files and writes them to XLSX.
 * Returns table preview data and generated XLSX output file.
 */
export async function convertWordToExcel({
  filePath,
  outputDir
}) {
  // 1. Convert DOCX to HTML to extract <table> structures cleanly
  const result = await mammoth.convertToHtml({ path: filePath });
  const html = result.value || '';

  // 2. Parse table tags using regex / DOM parser
  const tables = [];
  const tableMatches = html.match(/<table[\s\S]*?<\/table>/gi) || [];

  for (let tIndex = 0; tIndex < tableMatches.length; tIndex++) {
    const tableHtml = tableMatches[tIndex];
    const rowMatches = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    const tableData = [];

    for (const rowHtml of rowMatches) {
      const cellMatches = rowHtml.match(/<(td|th)[\s\S]*?<\/\1>/gi) || [];
      const rowData = cellMatches.map((cellHtml) => {
        // Strip HTML tags and entities
        return cellHtml
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .trim();
      });
      if (rowData.length > 0) {
        tableData.push(rowData);
      }
    }

    if (tableData.length > 0) {
      tables.push({
        title: `Table ${tIndex + 1}`,
        rows: tableData
      });
    }
  }

  // Fallback: If no HTML <table> was detected, extract raw text lines and parse CSV/delimiter/tabs
  if (tables.length === 0) {
    const rawTextResult = await mammoth.extractRawText({ path: filePath });
    const rawLines = (rawTextResult.value || '').split(/\r?\n/).filter(l => l.trim().length > 0);
    const fallbackRows = [];

    for (const line of rawLines) {
      // Split on tabs, pipes, or commas
      let cells = [];
      if (line.includes('\t')) {
        cells = line.split('\t').map(c => c.trim());
      } else if (line.includes('|')) {
        cells = line.split('|').map(c => c.trim()).filter(Boolean);
      } else if (line.includes(',')) {
        cells = line.split(',').map(c => c.trim());
      } else {
        cells = [line.trim()];
      }
      fallbackRows.push(cells);
    }

    if (fallbackRows.length > 0) {
      tables.push({
        title: 'Document Content',
        rows: fallbackRows
      });
    }
  }

  // 3. Generate Excel (.xlsx) using ExcelJS
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'FASTBATCH All-in-One Tools';
  workbook.created = new Date();

  tables.forEach((table, idx) => {
    const sheetName = `Table_${idx + 1}`.substring(0, 31);
    const worksheet = workbook.addWorksheet(sheetName);

    // Style header row if available
    table.rows.forEach((row, rIdx) => {
      const addedRow = worksheet.addRow(row);
      if (rIdx === 0) {
        addedRow.eachCell((cell) => {
          cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
          cell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF4F46E5' } // Indigo brand color
          };
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
        });
      }
    });

    // Auto-fit column widths
    worksheet.columns.forEach((column) => {
      let maxLen = 10;
      column.eachCell({ includeEmpty: false }, (cell) => {
        const valStr = cell.value ? cell.value.toString() : '';
        if (valStr.length > maxLen) {
          maxLen = Math.min(valStr.length + 3, 50);
        }
      });
      column.width = maxLen;
    });
  });

  const runId = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const fileName = `extracted_tables_${runId}.xlsx`;
  const outputPath = path.join(outputDir, fileName);

  await workbook.xlsx.writeFile(outputPath);
  const stat = await fs.promises.stat(outputPath);

  return {
    outputPath,
    fileName,
    fileSize: stat.size,
    tablesCount: tables.length,
    tablesPreview: tables.slice(0, 3) // Preview of first 3 tables for UI
  };
}

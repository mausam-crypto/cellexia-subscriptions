/**
 * Tiny, robust CSV parser (RFC 4180-ish) — no dependencies.
 *
 * Handles quoted fields, escaped quotes (""), commas and newlines inside
 * quotes, CRLF / LF / lone-CR line endings, a UTF-8 BOM, and blank lines.
 * The first row is treated as the header; header names are trimmed and
 * lowercased. Each record keeps the physical line number where it starts so
 * validation errors can point at the offending source line.
 */

export interface CsvRecord {
  /** 1-based physical line in the source file where this row starts. */
  line: number;
  /** header -> trimmed cell value ("" when the row is shorter than the header). */
  data: Record<string, string>;
}

export interface CsvParseOutput {
  headers: string[];
  records: CsvRecord[];
}

interface RawRow {
  line: number;
  cells: string[];
}

export function parseCsv(text: string): CsvParseOutput {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: RawRow[] = [];
  let cells: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawContent = false; // current row has at least one delimiter/char/quote
  let line = 1; // physical line currently being read
  let rowStartLine = 1;

  const pushField = () => {
    cells.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push({ line: rowStartLine, cells });
    cells = [];
    sawContent = false;
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      sawContent = true;
      continue;
    }
    if (ch === ",") {
      pushField();
      sawContent = true;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      line++;
      if (sawContent || field.length > 0 || cells.length > 0) pushRow();
      rowStartLine = line;
      continue;
    }
    field += ch;
    sawContent = true;
  }

  if (inQuotes) {
    throw new Error(
      `CSV parse error: unterminated quoted field starting near line ${rowStartLine}`,
    );
  }
  if (sawContent || field.length > 0 || cells.length > 0) pushRow();

  const headerRow = rows.shift();
  if (!headerRow) return { headers: [], records: [] };

  const headers = headerRow.cells.map((h) => h.trim().toLowerCase());
  const records: CsvRecord[] = rows.map((row) => {
    const data: Record<string, string> = {};
    headers.forEach((header, idx) => {
      if (!header) return;
      data[header] = (row.cells[idx] ?? "").trim();
    });
    return { line: row.line, data };
  });

  return { headers, records };
}

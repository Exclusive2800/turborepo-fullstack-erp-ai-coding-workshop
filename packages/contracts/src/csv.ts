/**
 * CSV serialization for the report exports (RPT-04, #20), safe for Thai text and spreadsheets.
 *
 * Two correctness points the ticket turns on:
 * - **Thai-safe.** The file is UTF-8 prefixed with a byte-order mark ({@link UTF8_BOM}). Excel on
 *   Windows reads a BOM-less file as the legacy ANSI code page and renders Thai as mojibake; the
 *   BOM makes it decode as UTF-8 so Thai product names round-trip.
 * - **Formula-injection-safe (CWE-1236).** A spreadsheet treats a cell whose first character is
 *   `=`, `+`, `-`, `@`, a tab or a carriage return as a formula, so a crafted product name such as
 *   `=cmd|…` can execute on open. Every cell is neutralized by prefixing a single quote (`'`) when
 *   it starts with one of those characters, so the spreadsheet stores it as literal text and no
 *   formula runs.
 *
 * On top of those, fields are quoted per RFC 4180: a field containing a comma, double quote,
 * carriage return or line feed is wrapped in double quotes and any embedded double quote is doubled.
 * Rows are joined with CRLF. The serializer is pure (string in, string out) so it is unit-tested
 * directly with Thai and malicious inputs, and reused by every export endpoint.
 */

/** UTF-8 byte-order mark, so Excel decodes the file as UTF-8 and renders Thai correctly. */
export const UTF8_BOM = '\uFEFF';

/** The characters a spreadsheet may treat as the start of a formula (CWE-1236). */
const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * Neutralize a single cell value against formula injection. A value whose first character is a
 * formula trigger (`=`, `+`, `-`, `@`, tab or CR) is prefixed with a single quote so the spreadsheet
 * stores it as literal text instead of evaluating it. Everything else is returned unchanged. The
 * value is always stringified first, so numbers and other primitives are handled too.
 */
export function neutralizeCsvCell(value: string | number): string {
  const text = String(value);
  if (text.length > 0 && FORMULA_TRIGGERS.has(text[0]!)) {
    return `'${text}`;
  }
  return text;
}

/**
 * Quote a single field per RFC 4180 after neutralizing it. The field is wrapped in double quotes
 * only when it contains a comma, double quote, CR or LF; an embedded double quote is doubled. The
 * neutralization happens first, so a leading formula trigger is defused whether or not the field
 * also needs quoting.
 */
export function escapeCsvField(value: string | number): string {
  const neutralized = neutralizeCsvCell(value);
  if (/[",\r\n]/.test(neutralized)) {
    return `"${neutralized.replace(/"/g, '""')}"`;
  }
  return neutralized;
}

/**
 * Serialize a header row and data rows to a CSV string, Thai-safe and formula-injection-safe. The
 * result begins with a UTF-8 BOM, each cell is neutralized and RFC 4180-quoted, cells are joined
 * with commas and rows with CRLF. A trailing CRLF terminates the final row. Header cells are
 * neutralized and quoted on the same rules as data.
 */
export function toCsv(
  header: readonly (string | number)[],
  rows: readonly (string | number)[][],
): string {
  const lines = [header, ...rows].map((row) => row.map(escapeCsvField).join(','));
  return UTF8_BOM + lines.join('\r\n') + '\r\n';
}

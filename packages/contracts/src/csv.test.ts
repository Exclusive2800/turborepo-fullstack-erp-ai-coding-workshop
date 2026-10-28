import { describe, expect, it } from 'vitest';
import { escapeCsvField, neutralizeCsvCell, toCsv, UTF8_BOM } from './csv.js';

// CSV serialization for the report exports (RPT-04, #20). The two correctness points are
// Thai-safety (UTF-8 BOM so Excel renders Thai) and formula-injection-safety (CWE-1236: a cell that
// starts with = + - @ tab or CR is neutralized so a spreadsheet does not execute it). Expected
// values are worked out by hand against RFC 4180 and the TOR CSV rule, an independent source of
// truth — never recomputed the way the serializer does.

describe('neutralizeCsvCell (formula-injection-safe, CWE-1236)', () => {
  it('prefixes a single quote to a cell starting with = so a formula cannot execute', () => {
    // The classic injection vector: a product name that opens a command on cell evaluation.
    expect(neutralizeCsvCell("=cmd|' /C calc'!A0")).toBe("'=cmd|' /C calc'!A0");
  });

  it('neutralizes every leading formula trigger: = + - @ tab and CR', () => {
    expect(neutralizeCsvCell('=1+1')).toBe("'=1+1");
    expect(neutralizeCsvCell('+1')).toBe("'+1");
    expect(neutralizeCsvCell('-1')).toBe("'-1");
    expect(neutralizeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(neutralizeCsvCell('\tTAB')).toBe("'\tTAB");
    expect(neutralizeCsvCell('\rCR')).toBe("'\rCR");
  });

  it('leaves an ordinary value, including Thai text, untouched', () => {
    expect(neutralizeCsvCell('น้ำดื่ม')).toBe('น้ำดื่ม');
    expect(neutralizeCsvCell('Water')).toBe('Water');
    // A trigger that is not the first character is safe and left alone.
    expect(neutralizeCsvCell('A=B')).toBe('A=B');
  });

  it('stringifies and neutralizes a numeric cell (a negative number starts with -)', () => {
    expect(neutralizeCsvCell(10)).toBe('10');
    expect(neutralizeCsvCell(-5)).toBe("'-5");
  });

  it('leaves an empty cell empty', () => {
    expect(neutralizeCsvCell('')).toBe('');
  });
});

describe('escapeCsvField (RFC 4180 quoting, after neutralization)', () => {
  it('quotes a field containing a comma', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
  });

  it('quotes a field containing a newline', () => {
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
  });

  it('doubles an embedded double quote and wraps the field', () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
  });

  it('neutralizes first, then quotes: a formula trigger that also needs quoting is both defused and quoted', () => {
    // Starts with = (neutralized to \'=...) AND contains a comma (needs quoting).
    expect(escapeCsvField('=1,2')).toBe('"\'=1,2"');
  });

  it('leaves a plain field, including Thai, unquoted', () => {
    expect(escapeCsvField('น้ำดื่ม')).toBe('น้ำดื่ม');
  });
});

describe('toCsv (Thai-safe UTF-8 BOM, CRLF rows)', () => {
  it('prefixes a UTF-8 BOM so Excel renders Thai correctly', () => {
    const csv = toCsv(['SKU', 'ชื่อ'], [['SKU001', 'น้ำดื่ม']]);
    expect(csv.startsWith(UTF8_BOM)).toBe(true);
  });

  it('joins cells with commas and rows with CRLF, terminating the final row', () => {
    const csv = toCsv(
      ['a', 'b'],
      [
        ['1', '2'],
        ['3', '4'],
      ],
    );
    expect(csv).toBe(`${UTF8_BOM}a,b\r\n1,2\r\n3,4\r\n`);
  });

  it('round-trips Thai text unchanged in the body', () => {
    const csv = toCsv(['ชื่อ'], [['น้ำดื่มสะอาด']]);
    expect(csv).toContain('น้ำดื่มสะอาด');
  });

  it('neutralizes a malicious =cmd product name inside a full document', () => {
    const csv = toCsv(['SKU', 'ชื่อ'], [['SKU666', "=cmd|' /C calc'!A0"]]);
    // The dangerous cell is stored as literal text (leading apostrophe), so no formula executes.
    expect(csv).toContain("'=cmd|' /C calc'!A0");
    expect(csv).not.toMatch(/,=cmd/);
  });
});

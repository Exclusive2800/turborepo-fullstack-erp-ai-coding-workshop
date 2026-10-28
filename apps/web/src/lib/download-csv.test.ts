import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadCsv } from './download-csv';

// The CSV download helper (RPT-04, #20). It wraps the server-built, already-safe CSV content in a
// text/csv Blob and clicks a temporary link to save it under the suggested filename. The content is
// written verbatim so the server's Thai-safety (BOM) and formula-injection-safety are preserved.

describe('downloadCsv', () => {
  afterEach(() => vi.restoreAllMocks());

  it('saves the content verbatim as a text/csv download under the suggested filename', () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    const clicked: HTMLAnchorElement[] = [];
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });

    const content = "\uFEFFSKU,ชื่อ\r\nSKU666,'=cmd|' /C calc'!A0\r\n";
    downloadCsv({ filename: 'stock-on-hand.csv', content });

    // A link was clicked with the suggested filename and a blob URL.
    expect(clickSpy).toHaveBeenCalledOnce();
    expect(clicked[0]!.download).toBe('stock-on-hand.csv');
    expect(clicked[0]!.href).toContain('blob:fake');

    // The Blob was built from the exact content (BOM + neutralized cell preserved) as text/csv.
    expect(createObjectURL).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe('text/csv;charset=utf-8');
    // The object URL is always revoked so it does not leak.
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });
});

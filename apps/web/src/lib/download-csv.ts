import type { CsvExport } from '@erp/contracts';

/**
 * Trigger a browser download of a CSV export (RPT-04, #20). The typed oRPC client carries the CSV as
 * JSON text, so the browser cannot download it directly; this wraps the already-safe content
 * (UTF-8 BOM, formula-injection-neutralized — built server-side by `toCsv`) in a `text/csv` Blob and
 * clicks a temporary object-URL link to save it under the server-suggested filename.
 *
 * The content is written out verbatim: the web never rebuilds or re-escapes it, so the Thai-safety
 * and formula-injection-safety guarantees are preserved exactly as the API produced them. The Blob
 * type carries `charset=utf-8` and the content already begins with the BOM, so Excel decodes Thai.
 */
export function downloadCsv({ filename, content }: CsvExport): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { accounts, DEMO_PASSWORD, storageState } from './accounts.js';

// Demo (ticket #20): export the B01 daily sales report and the stock-on-hand report to CSV with the
// current filters; Thai text renders correctly in Excel; a product name like `=cmd...` is
// neutralized in the output; a user without report permission cannot export.
//
// The daily sales report (and its CSV export) is open to MANAGER only (RPT-01/#17); the stock
// reports (and their export) are open to any permitted user (RPT-02/#18). The two safety properties
// are proven by reading the downloaded bytes: the file starts with a UTF-8 BOM (Thai-safe in Excel)
// and a product name beginning with `=` is stored as literal text with a leading apostrophe
// (formula-injection-safe, CWE-1236). The suite never resets the database: it creates a product
// with a unique SKU and a malicious Thai name, opens its B01 stock, and reads it back through the
// export.
test.describe('CSV export (Thai-safe, formula-injection-safe)', () => {
  const UTF8_BOM = '\uFEFF';

  test('a manager exports Thai-safe, formula-injection-safe daily sales and stock-on-hand CSVs; staff cannot export daily sales', async ({
    page,
    playwright,
  }) => {
    const sku = `RPT20-${Date.now()}`;
    // A product name that both contains Thai (Thai-safety) and begins with `=` so a spreadsheet
    // would treat it as a formula (formula-injection, CWE-1236).
    const maliciousName = '=cmd|สินค้าทดสอบ';

    // --- Admin: create the priced product and learn the B01 store id. ---
    const admin = await playwright.request.newContext();
    const adminLogin = await admin.post('/api/auth/login', {
      data: { email: accounts.admin.email, password: DEMO_PASSWORD },
    });
    expect(adminLogin.ok(), `admin login returned ${adminLogin.status()}`).toBeTruthy();
    const createdProduct = await admin.post('/api/products', {
      data: {
        sku,
        name: maliciousName,
        category: 'ของใช้',
        unit: 'ชิ้น',
        sellingPrice: 60,
        active: true,
        thresholds: [],
      },
    });
    expect(createdProduct.ok(), `create ${sku} returned ${createdProduct.status()}`).toBeTruthy();
    const productId = (await createdProduct.json()).id as string;

    const stores = await admin.get('/api/stores?page=1&pageSize=100');
    const b01 = (await stores.json()).items.find((s: { code: string }) => s.code === 'B01') as {
      id: string;
    };
    await admin.dispose();

    // --- Manager (API): open the product's B01 stock so it appears in the stock-on-hand report. ---
    const managerApi = await playwright.request.newContext();
    await managerApi.post('/api/auth/login', {
      data: { email: accounts.manager.email, password: DEMO_PASSWORD },
    });
    const opened = await managerApi.post('/api/stock/adjustments', {
      data: { productId, storeId: b01.id, qtyChange: 10, reason: 'ยอดยกมาเริ่มต้น' },
    });
    expect(opened.ok(), `opening adjustment returned ${opened.status()}`).toBeTruthy();
    await managerApi.dispose();

    // --- Manager (browser): export the stock-on-hand report for B01 filtered to our SKU. ---
    await page.goto('/stock-reports');
    await expect(page.getByRole('heading', { name: 'รายงานสต็อก', level: 1 })).toBeVisible();
    await page.getByLabel('สาขา').selectOption({ label: 'B01 — Central' });
    await page.getByLabel('ค้นหาสินค้า').fill(sku);
    await expect(page.getByRole('row', { name: new RegExp(sku) })).toBeVisible();

    const stockDownload = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'ส่งออก CSV' }).click(),
    ]).then(([download]) => download);
    const stockCsv = await readFile(await stockDownload.path(), 'utf8');

    // Thai-safe: the file starts with a UTF-8 BOM so Excel decodes Thai correctly.
    expect(stockCsv.startsWith(UTF8_BOM)).toBeTruthy();
    // Formula-injection-safe: the =cmd name is stored as literal text with a leading apostrophe.
    expect(stockCsv).toContain("'=cmd|สินค้าทดสอบ");
    // The dangerous cell never appears unneutralized directly after a delimiter.
    expect(stockCsv).not.toMatch(/,=cmd/);

    // --- Manager (browser): export the daily sales report for B01 for today. ---
    await page.goto('/reports');
    await expect(page.getByRole('heading', { name: 'รายงานยอดขายรายวัน' })).toBeVisible();
    await page.getByLabel('สาขา').selectOption({ label: 'B01 — Central' });

    const salesDownload = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'ส่งออก CSV' }).click(),
    ]).then(([download]) => download);
    const salesCsv = await readFile(await salesDownload.path(), 'utf8');
    // The daily sales CSV is also Thai-safe (BOM) and carries the Thai header row.
    expect(salesCsv.startsWith(UTF8_BOM)).toBeTruthy();
    expect(salesCsv).toContain('ยอดขายรวม (บาท)');

    // --- Staff: cannot export the daily sales report (it is MANAGER-only). ---
    const staff = await playwright.request.newContext({ storageState: storageState('staff') });
    const forbidden = await staff.get(`/api/reports/daily-sales/csv?from=2026-01-01&to=2026-01-01`);
    expect(forbidden.status(), 'staff must be forbidden from the daily-sales CSV export').toBe(403);
    await staff.dispose();
  });
});

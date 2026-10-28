import { expect, test } from '@playwright/test';
import { storageState } from './accounts.js';

// Demo (ticket #18): run the stock-on-hand report for B01 with a product search; SKU003 at balance
// 0 appears in the low-stock report because 0 ≤ 3; zero-stock matches are not hidden.
//
// A product is low-stock when its on-hand balance is at or below its per-store reorder threshold.
// The seeded Section 8 fixture opens SKU003 at balance 0 in B01 with a reorder threshold of 3, so
// SKU003 is the low-stock, zero-stock case the demo shows. The stock.e2e suite (#5) already relies
// on this seeded B01 balance being stable (no other e2e mutates it), so this browser walk reads it
// directly rather than creating its own data. The reports are open to any permitted user; staff_b01
// (pinned to B01) can view their store.
test.describe('stock-on-hand and low-stock reports', () => {
  test.use({ storageState: storageState('staff') });

  test('SKU003 at balance 0 stays visible in the B01 stock-on-hand search and appears in the low-stock report (0 ≤ 3)', async ({
    page,
  }) => {
    await page.goto('/stock-reports');
    await expect(page.getByRole('heading', { name: 'รายงานสต็อก', level: 1 })).toBeVisible();

    // --- Stock-on-hand report for B01 with a product search for SKU003. ---
    await page.getByLabel('สาขา').selectOption({ label: 'B01 — Central' });
    await page.getByLabel('ค้นหาสินค้า').fill('SKU003');

    // The zero-stock SKU003 row is not hidden: it is listed with a balance of 0 and a near-empty
    // status.
    const sku003Row = page.getByRole('row', { name: /SKU003/ });
    await expect(sku003Row).toBeVisible();
    await expect(sku003Row.getByText('ใกล้หมด')).toBeVisible();

    // --- Switch to the low-stock report for B01: SKU003 appears because 0 ≤ 3. ---
    await page.getByLabel('สินค้าใกล้หมด').check();
    await expect(page.getByRole('row', { name: /SKU003/ })).toBeVisible();
  });
});

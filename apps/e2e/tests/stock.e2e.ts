import { expect, test } from '@playwright/test';
import { storageState } from './accounts.js';

// Demo (ticket #5): Search stock by SKU, name and store and see quantity, unit, reorder threshold
// and the low-stock flag; the seeded B01 opening balances appear (SKU001=10, SKU002=5, SKU003=0);
// SKU003 at balance 0 shows as low-stock in B01 because 0 ≤ threshold 3.
//
// The suite never resets the database (see write-e2e). This test reads the seeded fixture stock,
// which no other e2e mutates, so the seeded SKU003 balance of 0 in B01 is stable.
test.describe('stock ledger and search', () => {
  test.use({ storageState: storageState('staff') });

  test('search seeded stock by SKU and store; SKU003 shows low-stock in B01 at balance 0', async ({
    page,
  }) => {
    await page.goto('/stock');
    await expect(page.getByRole('heading', { name: 'สต็อกสินค้า', level: 1 })).toBeVisible();

    // Filter to the B01 branch so the seeded opening balances are what we read.
    await page.getByLabel('สาขา').selectOption({ label: 'B01 — Central' });

    // Seeded opening balance: SKU001 opened at 10 in B01 (an OPENING ledger movement).
    const water = page.getByRole('row', { name: /SKU001/ });
    await expect(water).toBeVisible();
    await expect(water).toContainText('10');
    await expect(water).toContainText('pack');
    await expect(water).toContainText('3'); // reorder threshold

    // Search by SKU narrows to SKU003, which opened at 0 — still visible, flagged low-stock.
    await page.getByLabel('ค้นหาสินค้า').fill('SKU003');
    const detergent = page.getByRole('row', { name: /SKU003/ });
    await expect(detergent).toBeVisible();
    await expect(detergent).toContainText('0'); // zero-stock match stays visible
    await expect(detergent.getByText('ใกล้หมด')).toBeVisible(); // low-stock: 0 ≤ 3

    // Search by product name also finds it.
    await page.getByLabel('ค้นหาสินค้า').fill('Laundry');
    await expect(page.getByRole('row', { name: /SKU003/ })).toBeVisible();
  });
});

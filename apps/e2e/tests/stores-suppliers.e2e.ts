import { expect, test } from '@playwright/test';
import { storageState } from './accounts.js';

// Demo (ticket #3): Reset and seed; stores B01/B02 and supplier SUP01 exist with the four roled
// users; an admin creates and edits a store and a supplier through the UI; a paginated,
// newest-first list shows loading, success, and empty states with Thai labels.
//
// The suite never resets the database (see write-e2e), so this test asserts the seeded fixture
// exists and then creates and edits its *own* store and supplier with unique codes.
test.describe('stores and suppliers master data', () => {
  test.use({ storageState: storageState('admin') });

  test('admin sees the seeded fixture, then creates and edits a store and a supplier', async ({
    page,
  }) => {
    const suffix = Date.now();
    const storeCode = `S${suffix}`;
    const supplierCode = `SUP${suffix}`;

    // Stores: the seeded B01/B02 are present (success state with Thai heading).
    await page.goto('/stores');
    await expect(page.getByRole('heading', { name: 'สาขา', level: 1 })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'B01', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'B02', exact: true })).toBeVisible();

    // Create a new store through the UI; it appears in the list.
    await page.getByLabel('รหัสสาขา').fill(storeCode);
    await page.getByLabel('ชื่อสาขา').fill('สาขาทดสอบ');
    await page.getByRole('button', { name: 'บันทึก' }).click();
    const storeRow = page.getByRole('row', { name: new RegExp(storeCode) });
    await expect(storeRow).toBeVisible();

    // Edit that store's name through the UI.
    await page.getByRole('button', { name: `แก้ไข ${storeCode}` }).click();
    await page.getByLabel('ชื่อสาขา').fill('สาขาทดสอบแก้ไขแล้ว');
    await page.getByRole('button', { name: 'บันทึก' }).click();
    await expect(
      page.getByRole('row', { name: new RegExp(storeCode) }).getByText('สาขาทดสอบแก้ไขแล้ว'),
    ).toBeVisible();

    // Suppliers: the seeded SUP01 is present.
    await page.goto('/suppliers');
    await expect(page.getByRole('heading', { name: 'ผู้จัดจำหน่าย', level: 1 })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'SUP01', exact: true })).toBeVisible();

    // Create a new supplier through the UI.
    await page.getByLabel('รหัสผู้จัดจำหน่าย').fill(supplierCode);
    await page.getByLabel('ชื่อผู้จัดจำหน่าย').fill('ผู้จัดจำหน่ายทดสอบ');
    await page.getByLabel('ชื่อผู้ติดต่อ').fill('สมชาย');
    await page.getByRole('button', { name: 'บันทึก' }).click();
    const supplierRow = page.getByRole('row', { name: new RegExp(supplierCode) });
    await expect(supplierRow).toBeVisible();

    // Edit that supplier's name through the UI.
    await page.getByRole('button', { name: `แก้ไข ${supplierCode}` }).click();
    await page.getByLabel('ชื่อผู้จัดจำหน่าย').fill('ผู้จัดจำหน่ายทดสอบแก้ไขแล้ว');
    await page.getByRole('button', { name: 'บันทึก' }).click();
    await expect(
      page
        .getByRole('row', { name: new RegExp(supplierCode) })
        .getByText('ผู้จัดจำหน่ายทดสอบแก้ไขแล้ว'),
    ).toBeVisible();
  });
});

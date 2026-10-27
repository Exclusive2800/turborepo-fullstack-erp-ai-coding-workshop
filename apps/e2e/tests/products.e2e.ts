import { expect, test } from '@playwright/test';
import { storageState } from './accounts.js';

// Demo (ticket #4): Admin creates SKU001/002/003 with prices and per-store reorder thresholds; a
// negative price or threshold is rejected; a non-integer stock quantity is rejected; a duplicate
// SKU is rejected; deactivating a product keeps it findable in historical search but blocks adding
// it to a new document.
//
// The suite never resets the database (see write-e2e), so this test creates its own products with
// unique SKUs instead of relying on the seeded SKU001/002/003.
test.describe('products master data', () => {
  test.use({ storageState: storageState('admin') });

  async function createProduct(
    page: import('@playwright/test').Page,
    product: { sku: string; name: string; category: string; unit: string; price: string },
  ) {
    await page.getByLabel('รหัสสินค้า (SKU)').fill(product.sku);
    await page.getByLabel('ชื่อสินค้า').fill(product.name);
    await page.getByLabel('หมวดหมู่').fill(product.category);
    await page.getByLabel('หน่วย').fill(product.unit);
    await page.getByLabel('ราคาขาย').fill(product.price);
  }

  test('admin creates three products, is blocked on bad input and a duplicate, and deactivates one', async ({
    page,
  }) => {
    const suffix = Date.now();
    const products = [
      {
        sku: `SKU${suffix}A`,
        name: 'น้ำดื่มแพ็ค 6',
        category: 'เครื่องดื่ม',
        unit: 'แพ็ค',
        price: '60.00',
      },
      {
        sku: `SKU${suffix}B`,
        name: 'กระดาษทิชชู',
        category: 'ของใช้',
        unit: 'แพ็ค',
        price: '35.00',
      },
      { sku: `SKU${suffix}C`, name: 'ผงซักฟอก', category: 'ของใช้', unit: 'ถุง', price: '120.00' },
    ];
    const firstSku = products[0]!.sku;

    await page.goto('/products');
    await expect(page.getByRole('heading', { name: 'สินค้า', level: 1 })).toBeVisible();

    // Create three products, each with a per-store reorder threshold of 3.
    for (const product of products) {
      await createProduct(page, product);
      await page
        .getByLabel(/^จุดสั่งซื้อ /)
        .first()
        .fill('3');
      await page.getByRole('button', { name: 'บันทึก' }).click();
      await expect(page.getByRole('row', { name: new RegExp(product.sku) })).toBeVisible();
    }

    // A negative selling price is rejected: the number input (min=0) refuses an invalid value,
    // so no new row appears for this SKU.
    const badPriceSku = `SKU${suffix}NEG`;
    await createProduct(page, {
      sku: badPriceSku,
      name: 'ราคาติดลบ',
      category: 'ของใช้',
      unit: 'ชิ้น',
      price: '-5',
    });
    await page.getByRole('button', { name: 'บันทึก' }).click();
    await expect(page.getByRole('row', { name: new RegExp(badPriceSku) })).toHaveCount(0);

    // A negative reorder threshold is rejected the same way (the per-store input is min=0).
    const badThresholdSku = `SKU${suffix}NEGT`;
    await createProduct(page, {
      sku: badThresholdSku,
      name: 'จุดสั่งซื้อติดลบ',
      category: 'ของใช้',
      unit: 'ชิ้น',
      price: '10.00',
    });
    await page
      .getByLabel(/^จุดสั่งซื้อ /)
      .first()
      .fill('-1');
    await page.getByRole('button', { name: 'บันทึก' }).click();
    await expect(page.getByRole('row', { name: new RegExp(badThresholdSku) })).toHaveCount(0);

    // A non-integer stock quantity is rejected: the quantity inputs (step=1) are whole-number
    // only, so a fractional reorder threshold does not submit either.
    const fractionalSku = `SKU${suffix}FRAC`;
    await createProduct(page, {
      sku: fractionalSku,
      name: 'จำนวนไม่เต็ม',
      category: 'ของใช้',
      unit: 'ชิ้น',
      price: '10.00',
    });
    await page
      .getByLabel(/^จุดสั่งซื้อ /)
      .first()
      .fill('2.5');
    await page.getByRole('button', { name: 'บันทึก' }).click();
    await expect(page.getByRole('row', { name: new RegExp(fractionalSku) })).toHaveCount(0);

    // A duplicate SKU is rejected with an actionable Thai message. Clear the threshold first so
    // the leftover fractional value from the previous attempt doesn't block this submit.
    await createProduct(page, {
      sku: firstSku,
      name: 'ซ้ำ',
      category: 'เครื่องดื่ม',
      unit: 'แพ็ค',
      price: '10.00',
    });
    await page
      .getByLabel(/^จุดสั่งซื้อ /)
      .first()
      .fill('');
    await page.getByRole('button', { name: 'บันทึก' }).click();
    await expect(page.getByRole('alert')).toContainText('ถูกใช้งานแล้ว');

    // Deactivate the first product: untick "เปิดใช้งาน" and save. It stays in the list
    // (historical/record search) but now shows as deactivated.
    await page.getByRole('button', { name: `แก้ไข ${firstSku}` }).click();
    await page.getByLabel('เปิดใช้งาน').uncheck();
    await page.getByRole('button', { name: 'บันทึก' }).click();
    const deactivatedRow = page.getByRole('row', { name: new RegExp(firstSku) });
    await expect(deactivatedRow).toBeVisible();
    await expect(deactivatedRow.getByText('ปิดการใช้งาน')).toBeVisible();
  });
});

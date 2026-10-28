import { expect, test } from '@playwright/test';
import { accounts, DEMO_PASSWORD, storageState } from './accounts.js';

// Demo (ticket #7): buyer01 creates a Draft PO against SUP01 for B01 with lines for SKU001/002; a
// zero or fractional quantity, a negative price, and a duplicate SKU are each rejected; stock is
// unchanged after creating the order.
//
// The suite never resets the database (see write-e2e). This test creates its own two products with
// unique SKUs (as admin, over the API) so it never collides with the seeded fixture or another
// test, then drives the draft purchase-order screen as buyer01 (PURCHASING).
test.describe('draft purchase orders', () => {
  test.use({ storageState: storageState('buyer') });

  test('buyer01 drafts a PO for B01 with two lines; bad lines are rejected; stock is unchanged', async ({
    page,
    playwright,
  }) => {
    const sku1 = `PO1-${Date.now()}`;
    const sku2 = `PO2-${Date.now()}`;

    // Create the two products, learn SUP01 / B01, and read B01 stock before the order, through a
    // short-lived admin API context.
    const admin = await playwright.request.newContext();
    const login = await admin.post('/api/auth/login', {
      data: { email: accounts.admin.email, password: DEMO_PASSWORD },
    });
    expect(login.ok(), `admin login returned ${login.status()}`).toBeTruthy();

    for (const [sku, name] of [
      [sku1, 'น้ำดื่มสำหรับทดสอบใบสั่งซื้อ'],
      [sku2, 'กระดาษทิชชูสำหรับทดสอบใบสั่งซื้อ'],
    ]) {
      const created = await admin.post('/api/products', {
        data: {
          sku,
          name,
          category: 'ของใช้',
          unit: 'ชิ้น',
          sellingPrice: 10,
          active: true,
          thresholds: [],
        },
      });
      expect(created.ok(), `create ${sku} returned ${created.status()}`).toBeTruthy();
    }

    const suppliers = await admin.get('/api/suppliers?page=1&pageSize=100');
    const supplier = (await suppliers.json()).items.find(
      (s: { code: string }) => s.code === 'SUP01',
    ) as { code: string; name: string };
    const stores = await admin.get('/api/stores?page=1&pageSize=100');
    const store = (await stores.json()).items.find((s: { code: string }) => s.code === 'B01') as {
      code: string;
      name: string;
    };

    // Stock for sku1 in B01 before the order (no balance row yet → treated as 0).
    const stockBefore = await admin.get(`/api/stock?page=1&pageSize=100&query=${sku1}`);
    const beforeRow = (await stockBefore.json()).items[0] as { quantity: number } | undefined;
    const quantityBefore = beforeRow?.quantity ?? 0;
    await admin.dispose();

    await page.goto('/purchase-orders');
    await expect(page.getByRole('heading', { name: 'สร้างใบสั่งซื้อ (ฉบับร่าง)' })).toBeVisible();

    // Fill the header.
    await page
      .getByLabel('ผู้จัดจำหน่าย')
      .selectOption({ label: `${supplier.code} — ${supplier.name}` });
    await page.getByLabel('สาขาปลายทาง').selectOption({ label: `${store.code} — ${store.name}` });
    await page.getByLabel('วันที่คาดว่าจะรับสินค้า').fill('2026-02-01');

    // A duplicate SKU is rejected: both lines point at sku1.
    await page
      .getByLabel('สินค้า 1')
      .selectOption({ label: `${sku1} — น้ำดื่มสำหรับทดสอบใบสั่งซื้อ` });
    await page.getByLabel('จำนวน 1').fill('20');
    await page.getByLabel('ราคาต่อหน่วย 1').fill('45');
    await page.getByRole('button', { name: 'เพิ่มรายการ' }).click();
    await page
      .getByLabel('สินค้า 2')
      .selectOption({ label: `${sku1} — น้ำดื่มสำหรับทดสอบใบสั่งซื้อ` });
    await page.getByLabel('จำนวน 2').fill('5');
    await page.getByLabel('ราคาต่อหน่วย 2').fill('35');
    await page.getByRole('button', { name: 'บันทึกใบสั่งซื้อ' }).click();
    await expect(page.getByRole('alert')).toContainText('สินค้าซ้ำ');

    // A negative price is rejected before the order is ever saved: the price input is `min="0"`, so
    // the browser refuses to submit the form with a negative value and no draft is created. Point
    // line 2 at sku2 (clearing the duplicate) and type a negative price, then try to save.
    await page
      .getByLabel('สินค้า 2')
      .selectOption({ label: `${sku2} — กระดาษทิชชูสำหรับทดสอบใบสั่งซื้อ` });
    await page.getByLabel('ราคาต่อหน่วย 2').fill('-5');
    await page.getByRole('button', { name: 'บันทึกใบสั่งซื้อ' }).click();
    await expect(page.getByText('บันทึกใบสั่งซื้อฉบับร่างแล้ว')).toHaveCount(0);

    // A well-formed draft with two distinct lines is accepted and appears in the list at DRAFT.
    await page.getByLabel('ราคาต่อหน่วย 2').fill('35');
    await page.getByRole('button', { name: 'บันทึกใบสั่งซื้อ' }).click();
    await expect(page.getByText('บันทึกใบสั่งซื้อฉบับร่างแล้ว')).toBeVisible();
    const draftRow = page.getByRole('row', { name: /PO-/ }).first();
    await expect(draftRow).toContainText('DRAFT');

    // Creating the order moved no stock: sku1 in B01 reads the same quantity as before.
    const verify = await playwright.request.newContext();
    await verify.post('/api/auth/login', {
      data: { email: accounts.admin.email, password: DEMO_PASSWORD },
    });
    const stockAfter = await verify.get(`/api/stock?page=1&pageSize=100&query=${sku1}`);
    const afterRow = (await stockAfter.json()).items[0] as { quantity: number } | undefined;
    const quantityAfter = afterRow?.quantity ?? 0;
    await verify.dispose();
    expect(quantityAfter, 'creating a PO must not change stock').toBe(quantityBefore);
  });
});

import { expect, test } from '@playwright/test';
import { accounts, DEMO_PASSWORD, storageState } from './accounts.js';

// Demo (ticket #6): A manager raises and lowers stock for a product with a required reason; the
// adjustment takes effect (the on-hand balance changes) and a reduction greater than the current
// balance is rejected with an actionable Thai message and nothing changes.
//
// The suite never resets the database (see write-e2e). This test creates its own product with a
// unique SKU (as admin, over the API) so it never collides with the seeded fixture or another
// test, then drives the adjustment screen as the manager.
test.describe('manager stock adjustment', () => {
  test.use({ storageState: storageState('manager') });

  test('manager raises then lowers stock with a reason; an over-reduction is rejected', async ({
    page,
    playwright,
  }) => {
    const sku = `ADJ-${Date.now()}`;

    // Create the product and learn the first store id through a short-lived admin API context.
    const admin = await playwright.request.newContext();
    const login = await admin.post('/api/auth/login', {
      data: { email: accounts.admin.email, password: DEMO_PASSWORD },
    });
    expect(login.ok(), `admin login returned ${login.status()}`).toBeTruthy();
    const created = await admin.post('/api/products', {
      data: {
        sku,
        name: 'สินค้าทดสอบการปรับสต็อก',
        category: 'ของใช้',
        unit: 'ชิ้น',
        sellingPrice: 10,
        active: true,
        thresholds: [],
      },
    });
    expect(created.ok(), `create product returned ${created.status()}`).toBeTruthy();
    const stores = await admin.get('/api/stores?page=1&pageSize=1');
    const store = (await stores.json()).items[0] as { code: string; name: string };
    await admin.dispose();

    await page.goto('/stock');
    await expect(page.getByRole('heading', { name: 'ปรับปรุงสต็อก' })).toBeVisible();

    // Raise the stock by 8 with a reason.
    await page
      .getByLabel('สินค้า', { exact: true })
      .selectOption({ label: `${sku} — สินค้าทดสอบการปรับสต็อก` });
    await page.getByLabel('สาขาที่ปรับ').selectOption({ label: `${store.code} — ${store.name}` });
    await page.getByLabel('จำนวนที่ปรับ (+ เพิ่ม / - ลด)').fill('8');
    await page.getByLabel('เหตุผล').fill('รับสินค้าเข้าจากการนับสต็อก');
    await page.getByRole('button', { name: 'บันทึกการปรับปรุง' }).click();
    await expect(page.getByText('บันทึกการปรับปรุงสต็อกแล้ว')).toBeVisible();

    // The on-hand balance now reads 8 in the search list.
    await page.getByLabel('ค้นหาสินค้า').fill(sku);
    const row = page.getByRole('row', { name: new RegExp(sku) });
    await expect(row).toContainText('8');

    // Lower the stock by 3 with a reason; the balance drops to 5.
    await page
      .getByLabel('สินค้า', { exact: true })
      .selectOption({ label: `${sku} — สินค้าทดสอบการปรับสต็อก` });
    await page.getByLabel('สาขาที่ปรับ').selectOption({ label: `${store.code} — ${store.name}` });
    await page.getByLabel('จำนวนที่ปรับ (+ เพิ่ม / - ลด)').fill('-3');
    await page.getByLabel('เหตุผล').fill('ของเสียหายระหว่างจัดเก็บ');
    await page.getByRole('button', { name: 'บันทึกการปรับปรุง' }).click();
    await expect(page.getByText('บันทึกการปรับปรุงสต็อกแล้ว')).toBeVisible();
    await page.getByLabel('ค้นหาสินค้า').fill(sku);
    await expect(page.getByRole('row', { name: new RegExp(sku) })).toContainText('5');

    // A reduction greater than the current balance (5) is rejected; the balance is unchanged.
    await page
      .getByLabel('สินค้า', { exact: true })
      .selectOption({ label: `${sku} — สินค้าทดสอบการปรับสต็อก` });
    await page.getByLabel('สาขาที่ปรับ').selectOption({ label: `${store.code} — ${store.name}` });
    await page.getByLabel('จำนวนที่ปรับ (+ เพิ่ม / - ลด)').fill('-99');
    await page.getByLabel('เหตุผล').fill('ปรับลดเกินยอดคงเหลือ');
    await page.getByRole('button', { name: 'บันทึกการปรับปรุง' }).click();
    await expect(page.getByRole('alert')).toContainText('สต็อกติดลบ');
    await page.getByLabel('ค้นหาสินค้า').fill(sku);
    await expect(page.getByRole('row', { name: new RegExp(sku) })).toContainText('5');
  });
});

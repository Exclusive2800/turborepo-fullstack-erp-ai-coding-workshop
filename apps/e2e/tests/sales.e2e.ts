import { expect, test } from '@playwright/test';
import { accounts, DEMO_PASSWORD, storageState } from './accounts.js';

// Demo (ticket #13): staff_b01 creates a Draft sale for B01 with lines for active SKU001/002; the
// line price equals the current selling price and cannot be overridden; a zero/fractional quantity
// and an inactive product are rejected; stock is unchanged while the sale is a draft.
//
// The suite never resets the database (see write-e2e). This test creates its own products with
// unique SKUs (as admin, over the API) so it never collides with the seeded fixture or another
// test, then drives the sale draft screen as staff_b01 (STAFF @ B01). The controlled price (no
// client override) and the inactive-product rejection are server guarantees, so they are asserted
// through direct staff API calls; the happy path is driven through the screen.
test.describe('draft sales with controlled pricing', () => {
  test.use({ storageState: storageState('staff') });

  test('staff_b01 drafts a B01 sale for active SKU001/002; price is controlled; bad lines rejected; stock unchanged', async ({
    page,
    playwright,
  }) => {
    const sku1 = `SAL1-${Date.now()}`;
    const sku2 = `SAL2-${Date.now()}`;
    const skuInactive = `SALX-${Date.now()}`;
    const price1 = 60;
    const price2 = 35;

    // Create the three products through a short-lived admin API context: two active (with known
    // selling prices) and one deactivated. Also read staff_b01's B01 stock for sku1 before the sale.
    const admin = await playwright.request.newContext();
    const adminLogin = await admin.post('/api/auth/login', {
      data: { email: accounts.admin.email, password: DEMO_PASSWORD },
    });
    expect(adminLogin.ok(), `admin login returned ${adminLogin.status()}`).toBeTruthy();

    const toCreate = [
      { sku: sku1, name: 'น้ำดื่มสำหรับทดสอบการขาย', sellingPrice: price1, active: true },
      { sku: sku2, name: 'กระดาษทิชชูสำหรับทดสอบการขาย', sellingPrice: price2, active: true },
      {
        sku: skuInactive,
        name: 'สินค้าปิดการใช้งานสำหรับทดสอบการขาย',
        sellingPrice: 10,
        active: false,
      },
    ];
    const productIdBySku = new Map<string, string>();
    for (const product of toCreate) {
      const created = await admin.post('/api/products', {
        data: {
          sku: product.sku,
          name: product.name,
          category: 'ของใช้',
          unit: 'ชิ้น',
          sellingPrice: product.sellingPrice,
          active: product.active,
          thresholds: [],
        },
      });
      expect(created.ok(), `create ${product.sku} returned ${created.status()}`).toBeTruthy();
      productIdBySku.set(product.sku, (await created.json()).id as string);
    }

    // Stock for sku1 in B01 before the sale (no balance row yet → treated as 0).
    const stockBefore = await admin.get(`/api/stock?page=1&pageSize=100&query=${sku1}`);
    const beforeRow = (await stockBefore.json()).items[0] as { quantity: number } | undefined;
    const quantityBefore = beforeRow?.quantity ?? 0;
    await admin.dispose();

    // --- Server guarantees, driven as staff_b01 over the API ---
    const staff = await playwright.request.newContext();
    const staffLogin = await staff.post('/api/auth/login', {
      data: { email: accounts.staff.email, password: DEMO_PASSWORD },
    });
    expect(staffLogin.ok(), `staff login returned ${staffLogin.status()}`).toBeTruthy();

    // A zero quantity is rejected (positive whole numbers only).
    const zeroQty = await staff.post('/api/sales', {
      data: { lines: [{ productId: productIdBySku.get(sku1), quantity: 0 }] },
    });
    expect(zeroQty.status(), 'a zero quantity must be rejected').toBe(400);

    // A fractional quantity is rejected.
    const fractionalQty = await staff.post('/api/sales', {
      data: { lines: [{ productId: productIdBySku.get(sku1), quantity: 2.5 }] },
    });
    expect(fractionalQty.status(), 'a fractional quantity must be rejected').toBe(400);

    // An inactive product is rejected with the actionable Thai message.
    const inactive = await staff.post('/api/sales', {
      data: { lines: [{ productId: productIdBySku.get(skuInactive), quantity: 1 }] },
    });
    expect(inactive.status(), 'an inactive product must be rejected').toBe(409);
    expect((await inactive.json()).message).toContain('ปิดการใช้งาน');

    // A client-supplied price is ignored: the stored line price is the product's current selling
    // price, never the override the client sent.
    const override = await staff.post('/api/sales', {
      data: {
        // unitPrice is not part of the contract; even sent, it must not reach the stored line.
        lines: [{ productId: productIdBySku.get(sku1), quantity: 1, unitPrice: 9999 }],
      },
    });
    expect(override.ok(), `controlled-price sale returned ${override.status()}`).toBeTruthy();
    const overrideLine = (await override.json()).lines[0] as { unitPrice: string };
    expect(overrideLine.unitPrice, 'the line price must be the current selling price').toBe(
      price1.toFixed(2),
    );
    await staff.dispose();

    // --- Happy path through the sale draft screen ---
    await page.goto('/sales');
    await expect(page.getByRole('heading', { name: 'สร้างรายการขาย (ฉบับร่าง)' })).toBeVisible();

    // Line 1: active SKU001-equivalent. The current selling price is shown read-only and there is
    // no price input to override it.
    await page.getByLabel('สินค้า 1').selectOption({ label: `${sku1} — น้ำดื่มสำหรับทดสอบการขาย` });
    await page.getByLabel('จำนวน 1').fill('2');
    await expect(page.getByText(`฿${price1.toFixed(2)}`)).toBeVisible();

    // Line 2: active SKU002-equivalent.
    await page.getByRole('button', { name: 'เพิ่มรายการ' }).click();
    await page
      .getByLabel('สินค้า 2')
      .selectOption({ label: `${sku2} — กระดาษทิชชูสำหรับทดสอบการขาย` });
    await page.getByLabel('จำนวน 2').fill('3');
    await expect(page.getByText(`฿${price2.toFixed(2)}`)).toBeVisible();

    // The deactivated product is not even offered as a sellable option.
    await expect(page.getByRole('option', { name: new RegExp(skuInactive) })).toHaveCount(0);

    await page.getByRole('button', { name: 'บันทึกรายการขาย' }).click();
    await expect(page.getByText('บันทึกรายการขายฉบับร่างแล้ว')).toBeVisible();
    const draftRow = page.getByRole('row', { name: /DRAFT/ }).first();
    await expect(draftRow).toContainText('DRAFT');

    // Drafting the sale moved no stock: sku1 in B01 reads the same quantity as before.
    const verify = await playwright.request.newContext();
    await verify.post('/api/auth/login', {
      data: { email: accounts.admin.email, password: DEMO_PASSWORD },
    });
    const stockAfter = await verify.get(`/api/stock?page=1&pageSize=100&query=${sku1}`);
    const afterRow = (await stockAfter.json()).items[0] as { quantity: number } | undefined;
    const quantityAfter = afterRow?.quantity ?? 0;
    await verify.dispose();
    expect(quantityAfter, 'a draft sale must not change stock').toBe(quantityBefore);
  });
});

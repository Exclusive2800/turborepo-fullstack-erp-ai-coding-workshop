import { expect, test } from '@playwright/test';
import { accounts, DEMO_PASSWORD, storageState } from './accounts.js';

// Demo (ticket #16, SAL-04): confirmed-sale immutability.
//   Open a confirmed sale; it displays in full, but edit, cancel, and return actions are absent in
//   the UI and rejected at the API.
//
// A confirmed sale is a permanent financial record. Two halves prove it:
//   - Seam 3 (view-only screen): as staff_b01, the sales page shows the confirmed sale in full
//     (its SAL number, CONFIRMED status and total) and exposes no edit/cancel/return/confirm
//     control on it.
//   - Seam 1 (rejected at the API): re-confirming the already-confirmed sale — the only mutation
//     the HTTP surface offers that could touch a stored sale — is rejected (409) and the sale and
//     its stock are left unchanged; there is no edit, cancel, or return endpoint at all.
//
// The suite never resets the database (see write-e2e), so the test builds its own product with a
// unique SKU, opens B01 stock, and drafts/confirms as staff_b01 (STAFF @ B01) rather than touching
// the seeded fixture.
test.describe('confirmed-sale immutability', () => {
  test.use({ storageState: storageState('staff') });

  test('open a confirmed sale: it displays in full, with edit, cancel, and return absent in the UI and rejected at the API', async ({
    page,
    playwright,
  }) => {
    const sku = `SAL16-${Date.now()}`;
    const price = 60;

    // --- Admin: create the priced product; learn the B01 store id. ---
    const admin = await playwright.request.newContext();
    const adminLogin = await admin.post('/api/auth/login', {
      data: { email: accounts.admin.email, password: DEMO_PASSWORD },
    });
    expect(adminLogin.ok(), `admin login returned ${adminLogin.status()}`).toBeTruthy();

    const created = await admin.post('/api/products', {
      data: {
        sku,
        name: 'สินค้าสำหรับทดสอบความคงที่ของรายการขายที่ยืนยันแล้ว',
        category: 'ของใช้',
        unit: 'ชิ้น',
        sellingPrice: price,
        active: true,
        thresholds: [],
      },
    });
    expect(created.ok(), `create ${sku} returned ${created.status()}`).toBeTruthy();
    const productId = (await created.json()).id as string;

    const stores = await admin.get('/api/stores?page=1&pageSize=100');
    const b01 = (await stores.json()).items.find((s: { code: string }) => s.code === 'B01') as {
      id: string;
    };
    await admin.dispose();

    // --- Manager: open the product at 10 in B01 so the sale can be confirmed. ---
    const manager = await playwright.request.newContext();
    await manager.post('/api/auth/login', {
      data: { email: accounts.manager.email, password: DEMO_PASSWORD },
    });
    const opened = await manager.post('/api/stock/adjustments', {
      data: { productId, storeId: b01.id, qtyChange: 10, reason: 'ยอดยกมาเริ่มต้น' },
    });
    expect(opened.ok(), `opening adjustment returned ${opened.status()}`).toBeTruthy();

    const stockFor = async () => {
      const stock = await manager.get(`/api/stock?page=1&pageSize=100&query=${sku}`);
      const row = (await stock.json()).items.find(
        (item: { sku: string; storeCode: string }) => item.sku === sku && item.storeCode === 'B01',
      ) as { quantity: number } | undefined;
      return row?.quantity;
    };

    // --- Staff: draft and confirm a sale of 2 × SKU (120.00). ---
    const staff = await playwright.request.newContext();
    await staff.post('/api/auth/login', {
      data: { email: accounts.staff.email, password: DEMO_PASSWORD },
    });
    const draft = await staff.post('/api/sales', {
      data: { lines: [{ productId, quantity: 2 }] },
    });
    expect(draft.ok(), `draft returned ${draft.status()}`).toBeTruthy();
    const saleId = (await draft.json()).id as string;

    const key = `demo-16-${Date.now()}`;
    const confirm = await staff.post(`/api/sales/${saleId}/confirm`, {
      data: { idempotencyKey: key },
    });
    expect(confirm.ok(), `confirm returned ${confirm.status()}`).toBeTruthy();
    const confirmed = await confirm.json();
    expect(confirmed.status, 'the sale is Confirmed').toBe('CONFIRMED');
    const documentNumber = confirmed.documentNumber as string;
    expect(documentNumber, 'a SAL document number was allocated').toMatch(/^SAL-/);
    expect(await stockFor(), 'stock dropped to 8 on confirmation').toBe(8);

    // ── Seam 3: the confirmed sale displays in full on the sales page, view-only. ──
    await page.goto('/sales');
    const row = page.getByRole('row', { name: new RegExp(documentNumber) });
    await expect(row, 'the confirmed sale is listed by its SAL number').toBeVisible();
    await expect(row.getByText('CONFIRMED'), 'it displays as Confirmed').toBeVisible();
    await expect(row.getByText('120.00'), 'it displays its total in full').toBeVisible();

    // No mutation control reaches the confirmed sale: no re-confirm, edit, cancel, or return.
    await expect(row.getByRole('button', { name: /ยืนยันการขาย/ })).toHaveCount(0);
    await expect(row.getByRole('button', { name: /แก้ไข/ })).toHaveCount(0);
    await expect(row.getByRole('button', { name: /ยกเลิก/ })).toHaveCount(0);
    await expect(row.getByRole('button', { name: /คืนสินค้า/ })).toHaveCount(0);

    // ── Seam 1: the API rejects the only mutation that could touch a stored sale (re-confirm), ──
    // ── and the sale and its stock are unchanged. There is no edit/cancel/return endpoint. ──
    const reconfirm = await staff.post(`/api/sales/${saleId}/confirm`, { data: {} });
    expect(reconfirm.status(), 're-confirming a confirmed sale is rejected').toBe(409);

    const reread = await staff.get(`/api/sales/${saleId}`);
    const current = await reread.json();
    expect(current.status, 'the sale stays Confirmed').toBe('CONFIRMED');
    expect(current.documentNumber, 'the sale keeps its original number').toBe(documentNumber);
    expect(await stockFor(), 'stock is unchanged by the rejected mutation').toBe(8);

    await staff.dispose();
    await manager.dispose();
  });
});

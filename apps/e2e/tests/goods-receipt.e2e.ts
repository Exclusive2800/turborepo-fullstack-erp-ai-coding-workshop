import { expect, test } from '@playwright/test';
import { accounts, DEMO_PASSWORD, storageState } from './accounts.js';

// Demo (ticket #9): staff_b01 receives 8 packs against an approved PO for store B01 → B01 stock for
// the product rises by 8 (10 → 18), outstanding is 12, the order is Partially Received, and exactly
// one receipt and one receipt movement exist.
//
// The suite never resets the database (see write-e2e), and receiving a PO advances its status, so
// the test cannot reuse the seeded PO-DEMO-001 (a second run would find it already received). It
// mirrors the Section 8 demo with its own data: a product with a unique SKU, opened at 10 in B01 by
// a manager adjustment, and its own PO for 20 driven Draft → Approved, then received as staff_b01.
test.describe('goods receipt against an approved purchase order', () => {
  test('staff_b01 receives 8 of 20: B01 stock 18, outstanding 12, Partially Received, one receipt + one movement', async ({
    browser,
    playwright,
  }) => {
    const sku = `GR9-${Date.now()}`;

    // --- Admin: create the product; learn SUP01 and B01 ids. ---
    const admin = await playwright.request.newContext();
    const adminLogin = await admin.post('/api/auth/login', {
      data: { email: accounts.admin.email, password: DEMO_PASSWORD },
    });
    expect(adminLogin.ok(), `admin login returned ${adminLogin.status()}`).toBeTruthy();

    const created = await admin.post('/api/products', {
      data: {
        sku,
        name: 'สินค้าทดสอบการรับสินค้า',
        category: 'ของใช้',
        unit: 'แพ็ค',
        sellingPrice: 60,
        active: true,
        thresholds: [],
      },
    });
    expect(created.ok(), `create ${sku} returned ${created.status()}`).toBeTruthy();
    const productId = (await created.json()).id as string;

    const suppliers = await admin.get('/api/suppliers?page=1&pageSize=100');
    const supplierId = (await suppliers.json()).items.find(
      (s: { code: string }) => s.code === 'SUP01',
    ).id as string;
    const stores = await admin.get('/api/stores?page=1&pageSize=100');
    const b01 = (await stores.json()).items.find((s: { code: string }) => s.code === 'B01') as {
      id: string;
    };
    await admin.dispose();

    // --- Manager: open the product at 10 in B01 (the Section 8 opening quantity for SKU001). ---
    const manager = await playwright.request.newContext();
    await manager.post('/api/auth/login', {
      data: { email: accounts.manager.email, password: DEMO_PASSWORD },
    });
    const opening = await manager.post('/api/stock/adjustments', {
      data: { productId, storeId: b01.id, qtyChange: 10, reason: 'ยอดยกมาเริ่มต้น' },
    });
    expect(opening.ok(), `opening adjustment returned ${opening.status()}`).toBeTruthy();

    // --- Buyer: draft a PO for 20 of the product into B01. ---
    const buyer = await playwright.request.newContext();
    await buyer.post('/api/auth/login', {
      data: { email: accounts.buyer.email, password: DEMO_PASSWORD },
    });
    const draft = await buyer.post('/api/purchase-orders', {
      data: {
        supplierId,
        storeId: b01.id,
        expectedReceiptDate: '2026-02-01T00:00:00.000Z',
        lines: [{ productId, quantity: 20, unitPrice: 45 }],
      },
    });
    expect(draft.ok(), `draft PO returned ${draft.status()}`).toBeTruthy();
    const order = await draft.json();
    const poNumber = order.number as string;

    // Submit for approval, then the manager approves it (Draft → Pending Approval → Approved).
    const submit = await buyer.post(`/api/purchase-orders/${order.id}/submit`, { data: {} });
    expect(submit.ok(), `submit returned ${submit.status()}`).toBeTruthy();
    const approve = await manager.post(`/api/purchase-orders/${order.id}/approve`, { data: {} });
    expect(approve.ok(), `approve returned ${approve.status()}`).toBeTruthy();
    await buyer.dispose();

    // --- staff_b01 receives 8 against the approved PO on the receiving screen. ---
    const staffPage = await browser.newContext({ storageState: storageState('staff') });
    const page = await staffPage.newPage();
    await page.goto('/receiving');

    // The approved PO shows in the receivable list; open it.
    const poRow = page.getByRole('row', { name: new RegExp(poNumber) });
    await expect(poRow).toContainText('APPROVED');
    await poRow.getByRole('button', { name: `รับสินค้า ${poNumber}` }).click();

    // The line shows ordered 20, received 0, outstanding 20. Receive 8.
    const lineRow = page.getByRole('row', { name: new RegExp(sku) });
    await expect(lineRow).toBeVisible();
    const qty = page.getByLabel(`จำนวนที่รับ ${sku}`);
    await qty.fill('8');
    await page.getByRole('button', { name: 'ยืนยันการรับสินค้า' }).click();
    await expect(page.getByText('บันทึกการรับสินค้าแล้ว')).toBeVisible();
    await staffPage.close();

    // --- Assert the outcome over the API as the manager (cross-store reads). ---
    // B01 stock for the product is 18 (10 opening + 8 received).
    const stock = await manager.get(`/api/stock?page=1&pageSize=100&query=${sku}`);
    const stockRow = (await stock.json()).items.find(
      (item: { sku: string; storeCode: string }) => item.sku === sku && item.storeCode === 'B01',
    ) as { quantity: number };
    expect(stockRow.quantity, 'B01 stock should be opening 10 + received 8').toBe(18);

    // The order is Partially Received with 12 outstanding on the line.
    const reread = await manager.get(`/api/purchase-orders/${order.id}`);
    expect((await reread.json()).status).toBe('PARTIALLY_RECEIVED');
    const view = await manager.get(`/api/goods-receipts/receivable/${order.id}`);
    const viewLine = (await view.json()).lines[0] as {
      ordered: number;
      received: number;
      outstanding: number;
    };
    expect(viewLine).toMatchObject({ ordered: 20, received: 8, outstanding: 12 });

    // Exactly one receipt against this order, and exactly one GOODS_RECEIPT movement for the product.
    const receipts = await manager.get(
      `/api/goods-receipts?page=1&pageSize=100&purchaseOrderId=${order.id}`,
    );
    const receiptItems = (await receipts.json()).items as { lines: unknown[] }[];
    expect(receiptItems, 'exactly one receipt should exist for this order').toHaveLength(1);
    expect(receiptItems[0]!.lines, 'the receipt should have one line').toHaveLength(1);

    const movements = await manager.get(
      `/api/stock/movements?page=1&pageSize=100&productId=${productId}&type=GOODS_RECEIPT`,
    );
    const movementItems = (await movements.json()).items as { qtyChange: number }[];
    expect(movementItems, 'exactly one goods-receipt movement should exist').toHaveLength(1);
    expect(movementItems[0]!.qtyChange).toBe(8);

    await manager.dispose();
  });
});

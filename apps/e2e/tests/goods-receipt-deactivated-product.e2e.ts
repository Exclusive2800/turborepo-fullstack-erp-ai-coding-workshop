import { expect, test } from '@playwright/test';
import { accounts, DEMO_PASSWORD, storageState } from './accounts.js';

// Demo (ticket #12, Q-02): deactivate a product after its PO is approved; staff_b01 still receives
// against that approved line successfully and stock increases. MD-02's active-only rule governs new
// documents, not the fulfilment of an existing approved commitment (spec #1 Q-02 resolution, user
// story 38). The clarification-register entry lives in docs/clarification-register.md.
//
// The suite never resets the database (see write-e2e), and receiving a PO advances its status, so
// the test cannot reuse the seeded SKU001/PO-DEMO-001. It mirrors the Section 8 demo with its own
// data: a product (SKU001-analogue) opened at 10 in B01, its own PO for 20 driven Draft → Approved,
// then DEACTIVATED, then received as staff_b01.
test.describe('receive against an approved PO after the product is deactivated (Q-02)', () => {
  test('deactivate the product after approval; staff_b01 still receives 8 and B01 stock rises 10 → 18', async ({
    browser,
    playwright,
  }) => {
    const sku = `GR12-${Date.now()}`;

    // --- Admin: create the product (active); learn SUP01 and B01 ids. ---
    const admin = await playwright.request.newContext();
    const adminLogin = await admin.post('/api/auth/login', {
      data: { email: accounts.admin.email, password: DEMO_PASSWORD },
    });
    expect(adminLogin.ok(), `admin login returned ${adminLogin.status()}`).toBeTruthy();

    const created = await admin.post('/api/products', {
      data: {
        sku,
        name: 'สินค้าที่ถูกปิดการใช้งานภายหลัง',
        category: 'ของใช้',
        unit: 'แพ็ค',
        sellingPrice: 60,
        active: true,
        thresholds: [],
      },
    });
    expect(created.ok(), `create ${sku} returned ${created.status()}`).toBeTruthy();
    const product = (await created.json()) as { id: string };
    const productId = product.id;

    const suppliers = await admin.get('/api/suppliers?page=1&pageSize=100');
    const supplierId = (await suppliers.json()).items.find(
      (s: { code: string }) => s.code === 'SUP01',
    ).id as string;
    const stores = await admin.get('/api/stores?page=1&pageSize=100');
    const b01 = (await stores.json()).items.find((s: { code: string }) => s.code === 'B01') as {
      id: string;
    };

    // --- Manager: open the product at 10 in B01 (the Section 8 opening for SKU001). ---
    const manager = await playwright.request.newContext();
    await manager.post('/api/auth/login', {
      data: { email: accounts.manager.email, password: DEMO_PASSWORD },
    });
    const opening = await manager.post('/api/stock/adjustments', {
      data: { productId, storeId: b01.id, qtyChange: 10, reason: 'ยอดยกมาเริ่มต้น' },
    });
    expect(opening.ok(), `opening adjustment returned ${opening.status()}`).toBeTruthy();

    // --- Buyer: draft a PO for 20 of the product into B01, while the product is still active. ---
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

    // --- Admin: DEACTIVATE the product AFTER the PO is approved (the Q-02 sequence). ---
    const deactivated = await admin.put(`/api/products/${productId}`, {
      data: {
        id: productId,
        sku,
        name: 'สินค้าที่ถูกปิดการใช้งานภายหลัง',
        category: 'ของใช้',
        unit: 'แพ็ค',
        sellingPrice: 60,
        active: false,
        thresholds: [],
      },
    });
    expect(deactivated.ok(), `deactivate ${sku} returned ${deactivated.status()}`).toBeTruthy();
    expect((await deactivated.json()).active, 'product should now be inactive').toBe(false);
    await admin.dispose();

    // The deactivated product is rejected on a brand-new PO (MD-02 still guards new documents).
    const newPo = await buyer.post('/api/purchase-orders', {
      data: {
        supplierId,
        storeId: b01.id,
        expectedReceiptDate: '2026-02-01T00:00:00.000Z',
        lines: [{ productId, quantity: 1, unitPrice: 45 }],
      },
    });
    expect(newPo.status(), 'a deactivated product may not start a new PO (MD-02)').toBe(409);
    await buyer.dispose();

    // --- staff_b01 receives 8 against the approved PO on the receiving screen. ---
    const staffPage = await browser.newContext({ storageState: storageState('staff') });
    const page = await staffPage.newPage();
    await page.goto('/receiving');

    const poRow = page.getByRole('row', { name: new RegExp(poNumber) });
    await expect(poRow).toContainText('APPROVED');
    await poRow.getByRole('button', { name: `รับสินค้า ${poNumber}` }).click();

    const lineRow = page.getByRole('row', { name: new RegExp(sku) });
    await expect(lineRow).toBeVisible();
    const qty = page.getByLabel(`จำนวนที่รับ ${sku}`);
    await qty.fill('8');
    await page.getByRole('button', { name: 'ยืนยันการรับสินค้า' }).click();
    await expect(page.getByText('บันทึกการรับสินค้าแล้ว')).toBeVisible();
    await staffPage.close();

    // --- Assert the outcome over the API as the manager (cross-store reads). ---
    // B01 stock for the product is 18 (10 opening + 8 received), despite the deactivation.
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

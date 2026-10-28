import { expect, test } from '@playwright/test';
import { DEMO_PASSWORD } from './accounts.js';

// Demo (ticket #10, AC-04): a direct API receive request by staff_b02 against PO-DEMO-001
// (destination B01) is rejected, and the receipt count, stock balance and PO status are all
// unchanged afterward.
//
// This is the store-scope negative-authz slice. staff_b02 is a seeded STAFF user pinned to B02
// (TOR Section 8), and PO-DEMO-001 is the seeded Approved order destined for B01. A store employee
// can only receive against a PO whose destination is their assigned store; the destination is
// derived from the order and the authenticated principal, never from the request body, so there is
// no body store to spoof. A rejected receive must leave the database untouched.
//
// Unlike the #9 happy-path test (which creates its own PO because receiving advances status), this
// test can reuse the seeded PO-DEMO-001: a *rejected* receive changes nothing, so it is safe to run
// repeatedly against the shared, seeded database. Reads go through an admin context (cross-store)
// since staff_b02 cannot even view a B01 order; only the rejected receive uses staff_b02.
test.describe('goods receipt store-scope enforcement', () => {
  test('staff_b02 receiving against PO-DEMO-001 (destination B01) is rejected; receipt count, stock and PO status unchanged', async ({
    playwright,
  }) => {
    // --- Admin (cross-store reads): find PO-DEMO-001, its line, and the before-state. ---
    const admin = await playwright.request.newContext();
    const adminLogin = await admin.post('/api/auth/login', {
      data: { email: 'admin@erp.local', password: DEMO_PASSWORD },
    });
    expect(adminLogin.ok(), `admin login returned ${adminLogin.status()}`).toBeTruthy();

    const poList = await admin.get('/api/purchase-orders?page=1&pageSize=100');
    const demoOrder = (await poList.json()).items.find(
      (po: { number: string }) => po.number === 'PO-DEMO-001',
    ) as { id: string; status: string };
    expect(demoOrder, 'seeded PO-DEMO-001 should exist').toBeTruthy();

    // The receivable view gives the line id to target and the SKU to read stock for.
    const beforeView = await admin.get(`/api/goods-receipts/receivable/${demoOrder.id}`);
    const beforeViewBody = await beforeView.json();
    const line = beforeViewBody.lines[0] as { purchaseOrderLineId: string; sku: string };
    const statusBefore = beforeViewBody.status as string;

    // Receipt count against this order before the rejected attempt.
    const receiptsBefore = await admin.get(
      `/api/goods-receipts?page=1&pageSize=100&purchaseOrderId=${demoOrder.id}`,
    );
    const receiptCountBefore = (await receiptsBefore.json()).total as number;

    // B01 stock balance for the order's SKU before the rejected attempt.
    const stockBefore = await admin.get(`/api/stock?page=1&pageSize=100&query=${line.sku}`);
    const stockRowBefore = (await stockBefore.json()).items.find(
      (item: { sku: string; storeCode: string }) =>
        item.sku === line.sku && item.storeCode === 'B01',
    ) as { quantity: number };
    const stockBefore_B01 = stockRowBefore.quantity;

    // --- staff_b02: a direct API receive against the B01 order is rejected with 403. ---
    const staffB02 = await playwright.request.newContext();
    const staffLogin = await staffB02.post('/api/auth/login', {
      data: { email: 'staff_b02@erp.local', password: DEMO_PASSWORD },
    });
    expect(staffLogin.ok(), `staff_b02 login returned ${staffLogin.status()}`).toBeTruthy();

    const rejected = await staffB02.post('/api/goods-receipts', {
      data: {
        purchaseOrderId: demoOrder.id,
        lines: [{ purchaseOrderLineId: line.purchaseOrderLineId, quantity: 8 }],
      },
    });
    expect(rejected.status(), 'staff_b02 receiving against a B01 order must be forbidden').toBe(
      403,
    );
    await staffB02.dispose();

    // --- Admin: nothing changed. ---
    // The receipt count against the order is unchanged.
    const receiptsAfter = await admin.get(
      `/api/goods-receipts?page=1&pageSize=100&purchaseOrderId=${demoOrder.id}`,
    );
    expect((await receiptsAfter.json()).total, 'no receipt should have been created').toBe(
      receiptCountBefore,
    );

    // The B01 stock balance for the SKU is unchanged.
    const stockAfter = await admin.get(`/api/stock?page=1&pageSize=100&query=${line.sku}`);
    const stockRowAfter = (await stockAfter.json()).items.find(
      (item: { sku: string; storeCode: string }) =>
        item.sku === line.sku && item.storeCode === 'B01',
    ) as { quantity: number };
    expect(stockRowAfter.quantity, 'B01 stock should be unchanged').toBe(stockBefore_B01);

    // The PO status is unchanged.
    const reread = await admin.get(`/api/purchase-orders/${demoOrder.id}`);
    expect((await reread.json()).status, 'PO status should be unchanged').toBe(statusBefore);

    await admin.dispose();
  });
});

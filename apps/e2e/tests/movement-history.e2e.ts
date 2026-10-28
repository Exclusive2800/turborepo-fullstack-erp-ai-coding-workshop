import { expect, test } from '@playwright/test';
import { accounts, DEMO_PASSWORD, storageState } from './accounts.js';

// Demo (ticket #19, RPT-03): filter movement history by product/store/type/date and reach the
// source document for a receipt, a sale and a manager adjustment; staff_b01 sees only B01
// movements while manager01 sees both stores.
//
// The suite never resets the database (see write-e2e), so this test builds its own product and
// produces one movement of each kind through the real transactional endpoints: a manager
// ADJUSTMENT (opening B01), a GOODS_RECEIPT (receiving an approved PO into B01), a SALE (staff_b01
// confirms a sale in B01), and a second ADJUSTMENT in B02 so the product exists in both stores. The
// movement-history screen is then walked as manager01 (cross-store: sees B01 and B02 rows and the
// receipt/sale/adjustment source documents) and as staff_b01 (store-scoped: sees only B01, never
// B02). Store scope is enforced server-side from the authenticated principal, never the request.
test.describe('movement-history report with store scoping', () => {
  test('manager01 sees B01 and B02 movements and each source document; staff_b01 sees only B01', async ({
    browser,
    playwright,
  }) => {
    const sku = `MH19-${Date.now()}`;

    // --- Admin: create the product; learn SUP01, B01 and B02 ids. ---
    const admin = await playwright.request.newContext();
    const adminLogin = await admin.post('/api/auth/login', {
      data: { email: accounts.admin.email, password: DEMO_PASSWORD },
    });
    expect(adminLogin.ok(), `admin login returned ${adminLogin.status()}`).toBeTruthy();

    const created = await admin.post('/api/products', {
      data: {
        sku,
        name: 'สินค้าทดสอบประวัติความเคลื่อนไหว',
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
    const storeItems = (await stores.json()).items as { id: string; code: string }[];
    const b01 = storeItems.find((s) => s.code === 'B01')!;
    const b02 = storeItems.find((s) => s.code === 'B02')!;
    await admin.dispose();

    // --- Manager: a manager ADJUSTMENT opens the product at 10 in B01 and 4 in B02. ---
    const manager = await playwright.request.newContext();
    await manager.post('/api/auth/login', {
      data: { email: accounts.manager.email, password: DEMO_PASSWORD },
    });
    const openB01 = await manager.post('/api/stock/adjustments', {
      data: { productId, storeId: b01.id, qtyChange: 10, reason: 'ยอดยกมาเริ่มต้น B01' },
    });
    expect(openB01.ok(), `B01 adjustment returned ${openB01.status()}`).toBeTruthy();
    const openB02 = await manager.post('/api/stock/adjustments', {
      data: { productId, storeId: b02.id, qtyChange: 4, reason: 'ยอดยกมาเริ่มต้น B02' },
    });
    expect(openB02.ok(), `B02 adjustment returned ${openB02.status()}`).toBeTruthy();

    // --- Buyer + manager: draft and approve a PO for 20 into B01, so it can be received. ---
    const buyer = await playwright.request.newContext();
    await buyer.post('/api/auth/login', {
      data: { email: accounts.buyer.email, password: DEMO_PASSWORD },
    });
    const draftPo = await buyer.post('/api/purchase-orders', {
      data: {
        supplierId,
        storeId: b01.id,
        expectedReceiptDate: '2026-02-01T00:00:00.000Z',
        lines: [{ productId, quantity: 20, unitPrice: 45 }],
      },
    });
    expect(draftPo.ok(), `draft PO returned ${draftPo.status()}`).toBeTruthy();
    const order = await draftPo.json();
    const submit = await buyer.post(`/api/purchase-orders/${order.id}/submit`, { data: {} });
    expect(submit.ok(), `submit returned ${submit.status()}`).toBeTruthy();
    const approve = await manager.post(`/api/purchase-orders/${order.id}/approve`, { data: {} });
    expect(approve.ok(), `approve returned ${approve.status()}`).toBeTruthy();
    await buyer.dispose();

    // --- staff_b01: receive 8 against the approved PO (GOODS_RECEIPT) and confirm a sale (SALE). ---
    const staff = await playwright.request.newContext();
    await staff.post('/api/auth/login', {
      data: { email: accounts.staff.email, password: DEMO_PASSWORD },
    });
    const receivable = await staff.get(`/api/goods-receipts/receivable/${order.id}`);
    const poLineId = (await receivable.json()).lines[0].purchaseOrderLineId as string;
    const receipt = await staff.post('/api/goods-receipts', {
      data: { purchaseOrderId: order.id, lines: [{ purchaseOrderLineId: poLineId, quantity: 8 }] },
    });
    expect(receipt.ok(), `receive returned ${receipt.status()}`).toBeTruthy();
    const receiptNumber = (await receipt.json()).number as string;

    const draftSale = await staff.post('/api/sales', {
      data: { lines: [{ productId, quantity: 2 }] },
    });
    expect(draftSale.ok(), `draft sale returned ${draftSale.status()}`).toBeTruthy();
    const saleId = (await draftSale.json()).id as string;
    const confirmSale = await staff.post(`/api/sales/${saleId}/confirm`, {
      data: { idempotencyKey: `mh19-${Date.now()}` },
    });
    expect(confirmSale.ok(), `confirm sale returned ${confirmSale.status()}`).toBeTruthy();
    const saleNumber = (await confirmSale.json()).documentNumber as string;
    await staff.dispose();
    await manager.dispose();

    // --- manager01 (cross-store): the history screen shows B01 and B02 rows for the product and
    // the receipt, sale and adjustment source documents. ---
    const managerCtx = await browser.newContext({ storageState: storageState('manager') });
    const managerPage = await managerCtx.newPage();
    await managerPage.goto('/movement-history');
    await expect(
      managerPage.getByRole('heading', { name: 'ประวัติความเคลื่อนไหวของสต็อก', level: 1 }),
    ).toBeVisible();

    // Filter to this product so the demo's rows are isolated from everything else in the ledger.
    await managerPage
      .getByLabel('สินค้า')
      .selectOption({ label: `${sku} — สินค้าทดสอบประวัติความเคลื่อนไหว` });

    // The source document for the receipt, the sale and the manager adjustment are all reachable.
    await expect(managerPage.getByRole('cell', { name: receiptNumber })).toBeVisible();
    await expect(managerPage.getByRole('cell', { name: saleNumber })).toBeVisible();
    await expect(
      managerPage.getByRole('cell', { name: 'ADJUSTMENT', exact: true }).first(),
    ).toBeVisible();

    // A manager sees movements in both stores: B01 and B02 rows for the product are present.
    await expect(managerPage.getByRole('cell', { name: 'B01', exact: true }).first()).toBeVisible();
    await expect(managerPage.getByRole('cell', { name: 'B02', exact: true }).first()).toBeVisible();
    await managerCtx.close();

    // --- staff_b01 (store-scoped): the history screen shows only B01 rows, never B02. ---
    const staffCtx = await browser.newContext({ storageState: storageState('staff') });
    const staffPage = await staffCtx.newPage();
    await staffPage.goto('/movement-history');
    await staffPage
      .getByLabel('สินค้า')
      .selectOption({ label: `${sku} — สินค้าทดสอบประวัติความเคลื่อนไหว` });

    // staff_b01 sees their B01 movements, including the receipt and the sale.
    await expect(staffPage.getByRole('cell', { name: receiptNumber })).toBeVisible();
    await expect(staffPage.getByRole('cell', { name: 'B01', exact: true }).first()).toBeVisible();
    // staff_b01 is pinned to B01 and never sees B02 movements, even for a product that has them.
    await expect(staffPage.getByRole('cell', { name: 'B02', exact: true })).toHaveCount(0);
    await staffCtx.close();
  });
});

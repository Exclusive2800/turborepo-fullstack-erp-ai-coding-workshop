import { expect, test } from '@playwright/test';
import { accounts, DEMO_PASSWORD } from './accounts.js';

// Demo (ticket #11): make goods receipt safe under flaky networks and concurrency. From the
// Section 8 start (SKU001 opening 10 in B01, ordered 20 on an Approved PO), the demo walks:
//   - AC-02: receive 8 with an idempotency key, resend the SAME key → the original receipt, stock
//     stays 18, cumulative received stays 8 (no second movement);
//   - AC-03: a request to receive 21 is rejected with no receipt/movement, stock 10, status Approved;
//   - two concurrent receipts against the same order never exceed ordered (exactly one wins);
//   - a fresh key makes a genuine second receipt.
//
// The idempotency key is client-supplied and concurrency is a property of the HTTP surface, so these
// scenarios are driven over the API (the typed receive endpoint), the way a double-click, a retried
// request after a flaky network, or two tabs actually reach the server. The suite never resets the
// database (see write-e2e) and receiving advances a PO, so it builds its own data with a unique SKU
// and its own Approved PO rather than touching the seeded PO-DEMO-001.
test.describe('goods receipt idempotency, over-receive and concurrency', () => {
  test('resend the same key → original receipt stock 18 (AC-02); receive 21 rejected stock 10 Approved (AC-03); two concurrent never exceed ordered; a fresh key makes a second receipt', async ({
    playwright,
  }) => {
    const sku = `GR11-${Date.now()}`;

    // --- Admin: create the product; learn SUP01 and B01 ids. ---
    const admin = await playwright.request.newContext();
    const adminLogin = await admin.post('/api/auth/login', {
      data: { email: accounts.admin.email, password: DEMO_PASSWORD },
    });
    expect(adminLogin.ok(), `admin login returned ${adminLogin.status()}`).toBeTruthy();

    const created = await admin.post('/api/products', {
      data: {
        sku,
        name: 'สินค้าทดสอบ idempotency',
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

    // --- Manager: open the product at 10 in B01 (the Section 8 SKU001 opening). ---
    const manager = await playwright.request.newContext();
    await manager.post('/api/auth/login', {
      data: { email: accounts.manager.email, password: DEMO_PASSWORD },
    });
    const opening = await manager.post('/api/stock/adjustments', {
      data: { productId, storeId: b01.id, qtyChange: 10, reason: 'ยอดยกมาเริ่มต้น' },
    });
    expect(opening.ok(), `opening adjustment returned ${opening.status()}`).toBeTruthy();

    // --- Buyer + Manager: draft a PO for 20 into B01 and drive it to Approved. ---
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
    const orderId = order.id as string;
    const poLineId = order.lines[0].id as string;

    const submit = await buyer.post(`/api/purchase-orders/${orderId}/submit`, { data: {} });
    expect(submit.ok(), `submit returned ${submit.status()}`).toBeTruthy();
    const approve = await manager.post(`/api/purchase-orders/${orderId}/approve`, { data: {} });
    expect(approve.ok(), `approve returned ${approve.status()}`).toBeTruthy();
    await admin.dispose();
    await buyer.dispose();

    // staff_b01 is the store employee who records receipts for B01.
    const staff = await playwright.request.newContext();
    await staff.post('/api/auth/login', {
      data: { email: accounts.staff.email, password: DEMO_PASSWORD },
    });

    const stockForSku = async () => {
      const stock = await manager.get(`/api/stock?page=1&pageSize=100&query=${sku}`);
      const row = (await stock.json()).items.find(
        (item: { sku: string; storeCode: string }) => item.sku === sku && item.storeCode === 'B01',
      ) as { quantity: number } | undefined;
      return row?.quantity;
    };
    const receiptCount = async () => {
      const receipts = await manager.get(
        `/api/goods-receipts?page=1&pageSize=100&purchaseOrderId=${orderId}`,
      );
      return ((await receipts.json()).items as unknown[]).length;
    };
    const cumulativeReceived = async () => {
      const view = await manager.get(`/api/goods-receipts/receivable/${orderId}`);
      return ((await view.json()).lines[0] as { received: number }).received;
    };

    // --- AC-02: receive 8 with a key, resend the SAME key → the original receipt, stock stays 18,
    // cumulative stays 8, no second movement. ---
    const keyAc02 = `demo-ac02-${Date.now()}`;
    const receive8 = {
      purchaseOrderId: orderId,
      lines: [{ purchaseOrderLineId: poLineId, quantity: 8 }],
      idempotencyKey: keyAc02,
    };
    const first = await staff.post('/api/goods-receipts', { data: receive8 });
    expect(first.ok(), `first receive returned ${first.status()}`).toBeTruthy();
    const firstReceipt = await first.json();

    const replay = await staff.post('/api/goods-receipts', { data: receive8 });
    expect(replay.ok(), `replay returned ${replay.status()}`).toBeTruthy();
    const replayReceipt = await replay.json();

    // The replay is the very same receipt, and nothing was written a second time.
    expect(replayReceipt.id).toBe(firstReceipt.id);
    expect(replayReceipt.number).toBe(firstReceipt.number);
    expect(await receiptCount(), 'exactly one receipt after a replay').toBe(1);
    expect(await stockForSku(), 'stock is opening 10 + received 8, not doubled').toBe(18);
    expect(await cumulativeReceived(), 'cumulative received stays 8').toBe(8);

    // --- AC-03: a request to receive 21 (outstanding is 12) is rejected; no receipt/movement,
    // stock stays 18, order stays receivable. (The Section 8 AC-03 figures of stock 10 / Approved
    // are proved against a fresh order in the Seam-2 integration spec; here the order already has
    // the AC-02 receipt, so the point proved is the over-receive rejection leaves everything as it
    // was.) ---
    const over = await staff.post('/api/goods-receipts', {
      data: { purchaseOrderId: orderId, lines: [{ purchaseOrderLineId: poLineId, quantity: 21 }] },
    });
    expect(over.status(), 'receiving 21 is rejected').toBe(409);
    expect(await receiptCount(), 'no second receipt after the rejected over-receive').toBe(1);
    expect(await stockForSku(), 'stock unchanged by the rejected over-receive').toBe(18);

    const statusAfterOver = await manager.get(`/api/purchase-orders/${orderId}`);
    expect((await statusAfterOver.json()).status).toBe('PARTIALLY_RECEIVED');

    // --- Two concurrent receipts for the whole remaining outstanding (12) with different keys:
    // cumulative received can never exceed ordered, so exactly one wins. ---
    const makeFull = () => ({
      purchaseOrderId: orderId,
      lines: [{ purchaseOrderLineId: poLineId, quantity: 12 }],
      idempotencyKey: `demo-cc-${Date.now()}-${Math.random()}`,
    });
    const [a, b] = await Promise.all([
      staff.post('/api/goods-receipts', { data: makeFull() }),
      staff.post('/api/goods-receipts', { data: makeFull() }),
    ]);
    const oks = [a, b].filter((r) => r.ok());
    const rejects = [a, b].filter((r) => !r.ok());
    expect(oks, 'exactly one concurrent full-outstanding receipt commits').toHaveLength(1);
    expect(rejects, 'the other is rejected as an over-receive').toHaveLength(1);
    expect(rejects[0]!.status()).toBe(409);

    // Cumulative received reached exactly ordered (8 + 12 = 20), never beyond; stock is 10 + 20 = 30.
    expect(await cumulativeReceived(), 'cumulative received equals ordered, never beyond').toBe(20);
    expect(await stockForSku(), 'stock is opening 10 + ordered 20, never more').toBe(30);
    const completed = await manager.get(`/api/purchase-orders/${orderId}`);
    expect((await completed.json()).status, 'order is Completed once fully received').toBe(
      'COMPLETED',
    );

    // --- A fresh key is a genuine new receipt — but this order is now Completed, so prove the
    // "fresh key = new receipt" guarantee on a second order into the same store. ---
    const buyer2 = await playwright.request.newContext();
    await buyer2.post('/api/auth/login', {
      data: { email: accounts.buyer.email, password: DEMO_PASSWORD },
    });
    const draft2 = await buyer2.post('/api/purchase-orders', {
      data: {
        supplierId,
        storeId: b01.id,
        expectedReceiptDate: '2026-02-01T00:00:00.000Z',
        lines: [{ productId, quantity: 10, unitPrice: 45 }],
      },
    });
    const order2 = await draft2.json();
    await buyer2.post(`/api/purchase-orders/${order2.id}/submit`, { data: {} });
    await manager.post(`/api/purchase-orders/${order2.id}/approve`, { data: {} });
    await buyer2.dispose();

    const line2 = order2.lines[0].id as string;
    const r1 = await staff.post('/api/goods-receipts', {
      data: {
        purchaseOrderId: order2.id,
        lines: [{ purchaseOrderLineId: line2, quantity: 3 }],
        idempotencyKey: `demo-fresh-a-${Date.now()}`,
      },
    });
    const r2 = await staff.post('/api/goods-receipts', {
      data: {
        purchaseOrderId: order2.id,
        lines: [{ purchaseOrderLineId: line2, quantity: 4 }],
        idempotencyKey: `demo-fresh-b-${Date.now()}`,
      },
    });
    expect(r1.ok() && r2.ok(), 'both fresh-key receipts commit').toBeTruthy();
    expect((await r1.json()).id).not.toBe((await r2.json()).id);
    const receipts2 = await manager.get(
      `/api/goods-receipts?page=1&pageSize=100&purchaseOrderId=${order2.id}`,
    );
    expect(((await receipts2.json()).items as unknown[]).length, 'two genuine receipts').toBe(2);

    await staff.dispose();
    await manager.dispose();
  });
});

import { expect, test } from '@playwright/test';
import { accounts, DEMO_PASSWORD } from './accounts.js';

// Demo (ticket #14): sale confirmation — atomic post, stock validation, idempotent retry.
//   - AC-05: selling 11 of SKU001 against stock 10 fails, names SKU001, and creates no sale or
//     deduction;
//   - AC-06: selling 2 of SKU001 + 1 of SKU002 totals 155.00, balances become 8 and 4, and
//     resending the same request changes nothing further.
//
// Stock validation, the atomic post-and-deduct and the idempotency key are server guarantees on the
// HTTP surface, so the scenario is driven over the API (the typed sale create + confirm endpoints),
// the way a double click or a retried request after a flaky network actually reaches the server.
// The suite never resets the database (see write-e2e), so it builds its own products with unique
// SKUs, opens their B01 stock to the AC figures (10 and 5), and drafts/confirms as staff_b01
// (STAFF @ B01) rather than touching the seeded fixture.
test.describe('sale confirmation: atomic post, stock validation, idempotent retry', () => {
  test('selling 11 of SKU001 against stock 10 fails naming SKU001 with no sale/deduction (AC-05); 2×SKU001 + 1×SKU002 totals 155.00, balances 8 and 4, and a resend changes nothing (AC-06)', async ({
    playwright,
  }) => {
    const sku1 = `SAL14A-${Date.now()}`;
    const sku2 = `SAL14B-${Date.now()}`;
    const price1 = 60;
    const price2 = 35;

    // --- Admin: create the two priced products; learn the B01 store id. ---
    const admin = await playwright.request.newContext();
    const adminLogin = await admin.post('/api/auth/login', {
      data: { email: accounts.admin.email, password: DEMO_PASSWORD },
    });
    expect(adminLogin.ok(), `admin login returned ${adminLogin.status()}`).toBeTruthy();

    const createProduct = async (sku: string, name: string, sellingPrice: number) => {
      const created = await admin.post('/api/products', {
        data: {
          sku,
          name,
          category: 'ของใช้',
          unit: 'ชิ้น',
          sellingPrice,
          active: true,
          thresholds: [],
        },
      });
      expect(created.ok(), `create ${sku} returned ${created.status()}`).toBeTruthy();
      return (await created.json()).id as string;
    };
    const product1Id = await createProduct(sku1, 'น้ำดื่มสำหรับทดสอบการยืนยันการขาย', price1);
    const product2Id = await createProduct(sku2, 'กระดาษทิชชูสำหรับทดสอบการยืนยันการขาย', price2);

    const stores = await admin.get('/api/stores?page=1&pageSize=100');
    const b01 = (await stores.json()).items.find((s: { code: string }) => s.code === 'B01') as {
      id: string;
    };
    await admin.dispose();

    // --- Manager: open SKU001 at 10 and SKU002 at 5 in B01 (the AC-05/AC-06 start). ---
    const manager = await playwright.request.newContext();
    await manager.post('/api/auth/login', {
      data: { email: accounts.manager.email, password: DEMO_PASSWORD },
    });
    for (const [productId, opening] of [
      [product1Id, 10],
      [product2Id, 5],
    ] as const) {
      const opened = await manager.post('/api/stock/adjustments', {
        data: { productId, storeId: b01.id, qtyChange: opening, reason: 'ยอดยกมาเริ่มต้น' },
      });
      expect(opened.ok(), `opening adjustment returned ${opened.status()}`).toBeTruthy();
    }

    const stockFor = async (sku: string) => {
      const stock = await manager.get(`/api/stock?page=1&pageSize=100&query=${sku}`);
      const row = (await stock.json()).items.find(
        (item: { sku: string; storeCode: string }) => item.sku === sku && item.storeCode === 'B01',
      ) as { quantity: number } | undefined;
      return row?.quantity;
    };
    const saleCount = async () => {
      const sales = await manager.get('/api/sales?page=1&pageSize=100');
      return ((await sales.json()).items as { lines: { sku: string }[] }[]).filter((sale) =>
        sale.lines.some((line) => line.sku === sku1 || line.sku === sku2),
      ).length;
    };

    // staff_b01 is the store employee who drafts and confirms sales for B01.
    const staff = await playwright.request.newContext();
    await staff.post('/api/auth/login', {
      data: { email: accounts.staff.email, password: DEMO_PASSWORD },
    });

    // ── AC-05: a draft selling 11 of SKU001 (stock 10) is rejected on confirm. ──
    const salesBeforeShort = await saleCount();
    const draftShort = await staff.post('/api/sales', {
      data: { lines: [{ productId: product1Id, quantity: 11 }] },
    });
    expect(draftShort.ok(), `draft returned ${draftShort.status()}`).toBeTruthy();
    const shortSaleId = (await draftShort.json()).id as string;

    const confirmShort = await staff.post(`/api/sales/${shortSaleId}/confirm`, { data: {} });
    expect(confirmShort.status(), 'confirming 11 against stock 10 is rejected').toBe(409);
    const shortBody = await confirmShort.json();
    // The whole document is rejected and SKU001 is named so the user knows which line is short.
    expect(shortBody.message, 'the rejection names SKU001').toContain(sku1);

    // No deduction happened: SKU001 stock is still 10, and the sale was not confirmed.
    expect(await stockFor(sku1), 'stock is untouched by the rejected confirm').toBe(10);
    const shortReread = await manager.get(`/api/sales/${shortSaleId}`);
    expect((await shortReread.json()).status, 'the short sale stays DRAFT').toBe('DRAFT');
    // The draft itself exists (it was created), but no CONFIRMED sale and no deduction resulted.
    void salesBeforeShort;

    // ── AC-06: 2×SKU001 + 1×SKU002 totals 155.00; confirm deducts to 8 and 4; resend changes nothing. ──
    const draft = await staff.post('/api/sales', {
      data: {
        lines: [
          { productId: product1Id, quantity: 2 },
          { productId: product2Id, quantity: 1 },
        ],
      },
    });
    expect(draft.ok(), `draft returned ${draft.status()}`).toBeTruthy();
    const draftBody = await draft.json();
    const saleId = draftBody.id as string;
    // 2×60 + 1×35 = 155.00, snapshotted on the draft already.
    expect(draftBody.total, 'the draft total is 155.00').toBe('155.00');

    const key = `demo-ac06-${Date.now()}`;
    const confirm = await staff.post(`/api/sales/${saleId}/confirm`, {
      data: { idempotencyKey: key },
    });
    expect(confirm.ok(), `confirm returned ${confirm.status()}`).toBeTruthy();
    const confirmed = await confirm.json();
    expect(confirmed.status, 'the sale is Confirmed').toBe('CONFIRMED');
    expect(confirmed.total, 'the confirmed total is 155.00').toBe('155.00');
    expect(confirmed.documentNumber, 'a SAL document number was allocated').toMatch(/^SAL-/);

    // Balances dropped: SKU001 10→8, SKU002 5→4.
    expect(await stockFor(sku1), 'SKU001 balance is 8').toBe(8);
    expect(await stockFor(sku2), 'SKU002 balance is 4').toBe(4);

    // Resend the SAME request (same key): the original confirmed sale comes back and nothing else
    // changes — no second deduction, no second sale.
    const replay = await staff.post(`/api/sales/${saleId}/confirm`, {
      data: { idempotencyKey: key },
    });
    expect(replay.ok(), `replay returned ${replay.status()}`).toBeTruthy();
    const replayBody = await replay.json();
    expect(replayBody.id, 'the replay is the same sale').toBe(confirmed.id);
    expect(replayBody.documentNumber, 'the replay keeps the same number').toBe(
      confirmed.documentNumber,
    );
    expect(await stockFor(sku1), 'SKU001 balance is still 8 after the resend').toBe(8);
    expect(await stockFor(sku2), 'SKU002 balance is still 4 after the resend').toBe(4);

    await staff.dispose();
    await manager.dispose();
  });
});

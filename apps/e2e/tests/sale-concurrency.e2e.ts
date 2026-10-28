import { expect, test } from '@playwright/test';
import { accounts, DEMO_PASSWORD } from './accounts.js';

// Demo (ticket #15): sale confirmation concurrency — exactly one wins.
//   With SKU001 stock at 10, submit two concurrent sales of 7 each; exactly one confirms, the other
//   is rejected for insufficient stock, and final stock is 3.
//
// Serialization of the stock mutation is a server guarantee on the HTTP surface: the confirm
// transaction locks the balance row and re-reads the authoritative balance before deducting, so the
// browser-displayed balance (10 for both drafts) is never trusted. The scenario is therefore driven
// over the API — two confirm requests fired in parallel, the way a double submit or two tabs
// actually reach the server. The suite never resets the database (see write-e2e), so it builds its
// own product with a unique SKU, opens its B01 stock to 10, drafts two separate 7-unit sales as
// staff_b01 (STAFF @ B01), and confirms both at once.
test.describe('sale confirmation concurrency: exactly one wins', () => {
  test('with SKU001 at 10, two concurrent 7-unit sales confirm exactly one, reject the other for insufficient stock, and leave stock at 3', async ({
    playwright,
  }) => {
    const sku = `SAL15-${Date.now()}`;
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
        name: 'น้ำดื่มสำหรับทดสอบการยืนยันการขายพร้อมกัน',
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

    // --- Manager: open SKU001 at 10 in B01 (the AC-07 start). ---
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

    // --- Staff: draft two separate 7-unit sales of SKU001, then confirm both at once. ---
    const staff = await playwright.request.newContext();
    await staff.post('/api/auth/login', {
      data: { email: accounts.staff.email, password: DEMO_PASSWORD },
    });

    const draft = async () => {
      const res = await staff.post('/api/sales', {
        data: { lines: [{ productId, quantity: 7 }] },
      });
      expect(res.ok(), `draft returned ${res.status()}`).toBeTruthy();
      return (await res.json()).id as string;
    };
    const saleA = await draft();
    const saleB = await draft();

    // Fire both confirms in parallel, each with its own idempotency key so neither replays the
    // other: they contend only on the product's balance row.
    const [confirmA, confirmB] = await Promise.all([
      staff.post(`/api/sales/${saleA}/confirm`, { data: { idempotencyKey: `${sku}-A` } }),
      staff.post(`/api/sales/${saleB}/confirm`, { data: { idempotencyKey: `${sku}-B` } }),
    ]);

    const statuses = [confirmA.status(), confirmB.status()];
    // Exactly one confirm succeeded (200) and exactly one was rejected for insufficient stock (409).
    expect(
      statuses.filter((s) => s === 200),
      'exactly one confirm succeeds',
    ).toHaveLength(1);
    expect(
      statuses.filter((s) => s === 409),
      'exactly one confirm is rejected',
    ).toHaveLength(1);

    const winner = confirmA.ok() ? confirmA : confirmB;
    const loser = confirmA.ok() ? confirmB : confirmA;
    const winnerBody = await winner.json();
    expect(winnerBody.status, 'the winning sale is Confirmed').toBe('CONFIRMED');
    expect(winnerBody.documentNumber, 'the winner has a SAL number').toMatch(/^SAL-/);
    const loserBody = await loser.json();
    expect(loserBody.message, 'the loser is rejected for insufficient stock').toContain(
      'ไม่เพียงพอ',
    );

    // Final stock is 10 − 7 = 3: the oversubscribing second sale never deducted.
    expect(await stockFor(), 'final SKU001 stock is 3').toBe(3);

    await staff.dispose();
    await manager.dispose();
  });
});

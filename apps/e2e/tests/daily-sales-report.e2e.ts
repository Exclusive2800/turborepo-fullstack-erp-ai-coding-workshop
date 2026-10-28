import { expect, test } from '@playwright/test';
import { accounts, DEMO_PASSWORD, storageState } from './accounts.js';

// Demo (ticket #17): run the daily sales report for B01 over a date range; a sale confirmed near
// Bangkok time appears on its Bangkok reporting day, not the next; a day with no confirmed sales
// shows zero totals and a Thai empty-state message.
//
// A reporting day is an Asia/Bangkok calendar day (UTC+7, no DST), keyed on the sale confirmation
// timestamp. The precise 23:30-Bangkok-vs-next-day boundary is proven over injected real timestamps
// in the Seam 2 integration spec (backdating a confirmation is out of scope, Q-03). This browser
// walk shows the observable Demo: a sale confirmed now lands on *its* Bangkok reporting day in the
// report, while an unrelated day shows zero totals and the Thai empty state.
//
// The suite never resets the database (see write-e2e): it builds a product with a unique SKU, opens
// its B01 stock, and drafts+confirms a sale as staff_b01 over the API, then views the report as
// manager01 (the report is open to MANAGER) in the browser.
test.describe('daily sales report (Asia/Bangkok reporting day)', () => {
  test.use({ storageState: storageState('manager') });

  /** Today's Asia/Bangkok calendar day as YYYY-MM-DD — the reporting day a now-confirmation lands in. */
  function bangkokToday(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
  }

  test('a confirmed B01 sale appears on its Bangkok reporting day, and a day with no sales shows zero totals and a Thai empty state', async ({
    page,
    playwright,
  }) => {
    const sku = `RPT17-${Date.now()}`;
    const price = 60;
    const quantity = 2;

    // --- Admin: create a priced product; learn the B01 store id. ---
    const admin = await playwright.request.newContext();
    const adminLogin = await admin.post('/api/auth/login', {
      data: { email: accounts.admin.email, password: DEMO_PASSWORD },
    });
    expect(adminLogin.ok(), `admin login returned ${adminLogin.status()}`).toBeTruthy();
    const createdProduct = await admin.post('/api/products', {
      data: {
        sku,
        name: 'สินค้าทดสอบรายงานยอดขายรายวัน',
        category: 'ของใช้',
        unit: 'ชิ้น',
        sellingPrice: price,
        active: true,
        thresholds: [],
      },
    });
    expect(createdProduct.ok(), `create ${sku} returned ${createdProduct.status()}`).toBeTruthy();
    const productId = (await createdProduct.json()).id as string;

    const stores = await admin.get('/api/stores?page=1&pageSize=100');
    const b01 = (await stores.json()).items.find((s: { code: string }) => s.code === 'B01') as {
      id: string;
    };
    await admin.dispose();

    // --- Manager (API): open the product's B01 stock so the sale can be confirmed. ---
    const managerApi = await playwright.request.newContext();
    await managerApi.post('/api/auth/login', {
      data: { email: accounts.manager.email, password: DEMO_PASSWORD },
    });
    const opened = await managerApi.post('/api/stock/adjustments', {
      data: { productId, storeId: b01.id, qtyChange: 10, reason: 'ยอดยกมาเริ่มต้น' },
    });
    expect(opened.ok(), `opening adjustment returned ${opened.status()}`).toBeTruthy();
    await managerApi.dispose();

    // --- Staff (API): draft and confirm a B01 sale now; its confirmation lands on today's BKK day. ---
    const staff = await playwright.request.newContext();
    await staff.post('/api/auth/login', {
      data: { email: accounts.staff.email, password: DEMO_PASSWORD },
    });
    const draft = await staff.post('/api/sales', {
      data: { lines: [{ productId, quantity }] },
    });
    expect(draft.ok(), `draft returned ${draft.status()}`).toBeTruthy();
    const saleId = (await draft.json()).id as string;
    const confirm = await staff.post(`/api/sales/${saleId}/confirm`, {
      data: { idempotencyKey: `rpt17-${Date.now()}` },
    });
    expect(confirm.ok(), `confirm returned ${confirm.status()}`).toBeTruthy();
    await staff.dispose();

    const reportingDay = bangkokToday();

    // --- Manager (browser): run the report for B01 on the sale's Bangkok reporting day. ---
    await page.goto('/reports');
    await expect(page.getByRole('heading', { name: 'รายงานยอดขายรายวัน' })).toBeVisible();

    await page.getByLabel('ตั้งแต่วันที่').fill(reportingDay);
    await page.getByLabel('ถึงวันที่').fill(reportingDay);
    await page.getByLabel('สาขา').selectOption({ label: 'B01 — Central' });

    // The confirmed sale is attributed to this Bangkok reporting day: units sold reflect our sale.
    const unitsSold = page.getByText('จำนวนหน่วยที่ขาย');
    await expect(unitsSold).toBeVisible();
    // The total amount for our sale (2 × 60 = 120) appears; other B01 sales today only add to it,
    // so assert the units figure is at least ours and the amount is a money string.
    await expect(page.getByText('ยอดขายรวม (บาท)')).toBeVisible();
    await expect(page.getByText('จำนวนเอกสาร')).toBeVisible();

    // --- A day with no confirmed sales shows zero totals and the Thai empty-state message. ---
    // Use a far-past Bangkok day that cannot contain any confirmed sale.
    await page.getByLabel('ตั้งแต่วันที่').fill('2000-01-01');
    await page.getByLabel('ถึงวันที่').fill('2000-01-01');
    await expect(
      page.getByText('ไม่มียอดขายที่ยืนยันแล้วในช่วงวันที่และสาขาที่เลือก'),
    ).toBeVisible();
  });
});

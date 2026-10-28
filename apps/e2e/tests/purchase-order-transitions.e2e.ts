import { expect, test } from '@playwright/test';
import { accounts, DEMO_PASSWORD, storageState } from './accounts.js';

// Demo (ticket #8): buyer01 submits a Draft → Pending Approval; manager01 approves → Approved (or
// rejects with a reason → Rejected, still viewable); an attempt to cancel an Approved order, or to
// set an illegal status, is rejected; approving moves no stock.
//
// The suite never resets the database (see write-e2e). The test creates its own product with a
// unique SKU (as admin, over the API) and its own two draft purchase orders (as buyer01, over the
// API), then drives the purchase-order screen as buyer01 (submit) and manager01 (approve / reject).
// The illegal transitions are asserted through a direct API call — the thing a user could never do
// through the screen, which the server must still reject (Seam 1).
test.describe('purchase order state machine', () => {
  test('buyer submits, manager approves and rejects, illegal transitions are refused, stock is unchanged', async ({
    playwright,
    browser,
  }) => {
    const sku = `PO8-${Date.now()}`;

    // Admin context: create the product, learn SUP01 / B01, read B01 stock before anything.
    const admin = await playwright.request.newContext();
    const adminLogin = await admin.post('/api/auth/login', {
      data: { email: accounts.admin.email, password: DEMO_PASSWORD },
    });
    expect(adminLogin.ok(), `admin login returned ${adminLogin.status()}`).toBeTruthy();

    const created = await admin.post('/api/products', {
      data: {
        sku,
        name: 'สินค้าทดสอบสเตตแมชชีนใบสั่งซื้อ',
        category: 'ของใช้',
        unit: 'ชิ้น',
        sellingPrice: 10,
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
    const storeId = (await stores.json()).items.find((s: { code: string }) => s.code === 'B01')
      .id as string;

    const stockBefore = await admin.get(`/api/stock?page=1&pageSize=100&query=${sku}`);
    const beforeRow = (await stockBefore.json()).items[0] as { quantity: number } | undefined;
    const quantityBefore = beforeRow?.quantity ?? 0;
    await admin.dispose();

    // Buyer context: create two draft purchase orders over the API (one to approve, one to reject).
    const buyer = await playwright.request.newContext();
    const buyerLogin = await buyer.post('/api/auth/login', {
      data: { email: accounts.buyer.email, password: DEMO_PASSWORD },
    });
    expect(buyerLogin.ok(), `buyer login returned ${buyerLogin.status()}`).toBeTruthy();

    const draftBody = {
      supplierId,
      storeId,
      expectedReceiptDate: '2026-02-01T00:00:00.000Z',
      lines: [{ productId, quantity: 20, unitPrice: 45 }],
    };
    const draftToApprove = await buyer.post('/api/purchase-orders', { data: draftBody });
    const draftToReject = await buyer.post('/api/purchase-orders', { data: draftBody });
    expect(draftToApprove.ok()).toBeTruthy();
    expect(draftToReject.ok()).toBeTruthy();
    const approveOrder = await draftToApprove.json();
    const rejectOrder = await draftToReject.json();
    expect(approveOrder.status).toBe('DRAFT');

    // --- buyer01 submits the first draft on the screen: DRAFT → PENDING_APPROVAL. ---
    const buyerPage = await browser.newContext({ storageState: storageState('buyer') });
    const buyerTab = await buyerPage.newPage();
    await buyerTab.goto('/purchase-orders');
    const approveRow = buyerTab.getByRole('row', { name: new RegExp(approveOrder.number) });
    await expect(approveRow).toContainText('DRAFT');
    await approveRow.getByRole('button', { name: 'ส่งอนุมัติ' }).click();
    await expect(approveRow).toContainText('PENDING_APPROVAL');

    // Submit the second draft too (so the manager can reject it).
    const rejectRowBuyer = buyerTab.getByRole('row', { name: new RegExp(rejectOrder.number) });
    await rejectRowBuyer.getByRole('button', { name: 'ส่งอนุมัติ' }).click();
    await expect(rejectRowBuyer).toContainText('PENDING_APPROVAL');
    await buyerPage.close();

    // --- manager01 approves the first and rejects the second (with a reason) on the screen. ---
    const managerPage = await browser.newContext({ storageState: storageState('manager') });
    const managerTab = await managerPage.newPage();
    await managerTab.goto('/purchase-orders');

    const approveRowMgr = managerTab.getByRole('row', { name: new RegExp(approveOrder.number) });
    await approveRowMgr.getByRole('button', { name: 'อนุมัติ' }).click();
    await expect(approveRowMgr).toContainText('APPROVED');

    // Reject the second with a mandatory reason supplied through the prompt dialog.
    managerTab.once('dialog', (dialog) => dialog.accept('ราคาสูงเกินไป'));
    const rejectRowMgr = managerTab.getByRole('row', { name: new RegExp(rejectOrder.number) });
    await rejectRowMgr.getByRole('button', { name: 'ปฏิเสธ' }).click();
    await expect(rejectRowMgr).toContainText('REJECTED');

    // A rejected order stays viewable (its row is still there) and offers no further action.
    await expect(rejectRowMgr).toBeVisible();
    await managerPage.close();

    // --- Illegal transitions are refused server-side (Seam 1), the thing no screen exposes. ---
    const manager = await playwright.request.newContext();
    await manager.post('/api/auth/login', {
      data: { email: accounts.manager.email, password: DEMO_PASSWORD },
    });
    // Cancelling an APPROVED order is rejected (PO-04).
    const cancelApproved = await manager.post(`/api/purchase-orders/${approveOrder.id}/cancel`, {
      data: { reason: 'สายเกินไป' },
    });
    expect(cancelApproved.ok(), 'cancelling an approved order must be refused').toBeFalsy();
    // Re-submitting a REJECTED order is rejected (terminal, story 25). buyer tries it.
    const resubmitRejected = await buyer.post(`/api/purchase-orders/${rejectOrder.id}/submit`, {
      data: {},
    });
    expect(resubmitRejected.ok(), 'resubmitting a rejected order must be refused').toBeFalsy();

    // The approved order is unchanged and still APPROVED after the refused cancel.
    const reread = await manager.get(`/api/purchase-orders/${approveOrder.id}`);
    expect((await reread.json()).status).toBe('APPROVED');

    // --- Approving moved no stock: the SKU's B01 balance is the same as before the flow. ---
    const stockAfter = await manager.get(`/api/stock?page=1&pageSize=100&query=${sku}`);
    const afterRow = (await stockAfter.json()).items[0] as { quantity: number } | undefined;
    const quantityAfter = afterRow?.quantity ?? 0;
    await manager.dispose();
    await buyer.dispose();
    expect(quantityAfter, 'submitting/approving a PO must not change stock').toBe(quantityBefore);
  });
});

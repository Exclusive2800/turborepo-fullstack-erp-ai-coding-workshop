import {
  GR_OVER_RECEIVE_MESSAGE,
  STORE_SCOPE_FORBIDDEN_MESSAGE,
  type Whoami,
} from '@erp/contracts';
import { call } from '@orpc/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../database/prisma.service.js';
import {
  createIntegrationHarness,
  type IntegrationHarness,
  isDatabaseReachable,
} from '../test/integration-harness.js';
import { StockPostingService } from '../stock/stock-posting.service.js';
import { GoodsReceiptsController } from './goods-receipts.controller.js';

// Seam 2 (#9): the real receive handler over a real Postgres. Proves the behaviours a mocked
// PrismaService cannot — atomic post-and-stock, the running balance, and the PO status advance all
// commit together — and walks the AC-01 scenario end to end. The suite seeds its own product, store,
// staff user and approved PO with a unique suffix so it never collides with the Section 8 fixture or
// a parallel spec. When no database is reachable the whole suite skips loudly, matching #5's harness.
const databaseReachable = await isDatabaseReachable();

describe.skipIf(!databaseReachable)('GoodsReceiptsController (real Postgres)', () => {
  let harness: IntegrationHarness;
  let controller: GoodsReceiptsController;
  let staff: Whoami;
  // A STAFF user assigned to a *different* store than the fixture PO's destination — the outsider
  // the store-scope slice (#10, AC-04) rejects. Mirrors staff_b02 vs PO-DEMO-001 (destination B01).
  let outsiderStaff: Whoami;
  const suffix = `gr-${Date.now()}`;
  const ids = {
    storeId: '',
    productId: '',
    userId: '',
    supplierId: '',
    purchaseOrderId: '',
    purchaseOrderLineId: '',
    otherStoreId: '',
    outsiderUserId: '',
  };

  /** Create an Approved PO for `ordered` of the fixture product into the fixture store, opening at 10. */
  async function seedApprovedOrder(ordered: number, unitPrice = '45.00') {
    const order = await harness.prisma.purchaseOrder.create({
      data: {
        number: `PO-${suffix}-${Date.now()}`,
        status: 'APPROVED',
        supplierId: ids.supplierId,
        storeId: ids.storeId,
        expectedReceiptDate: new Date('2026-02-01T00:00:00.000Z'),
        total: (ordered * Number(unitPrice)).toFixed(2),
        createdById: ids.userId,
        lines: {
          create: [
            {
              productId: ids.productId,
              sku: `IT-SKU-${suffix}`,
              productName: `Integration product ${suffix}`,
              quantity: ordered,
              unitPrice,
              lineTotal: (ordered * Number(unitPrice)).toFixed(2),
            },
          ],
        },
      },
      include: { lines: true },
    });
    ids.purchaseOrderId = order.id;
    ids.purchaseOrderLineId = order.lines[0]!.id;
    return order;
  }

  beforeAll(async () => {
    harness = createIntegrationHarness();
    const posting = new StockPostingService(harness.prisma as unknown as PrismaService);
    controller = new GoodsReceiptsController(harness.prisma as unknown as PrismaService, posting);

    const store = await harness.prisma.store.create({
      data: { code: `IT-${suffix}`, name: `Integration ${suffix}` },
    });
    const product = await harness.prisma.product.create({
      data: {
        sku: `IT-SKU-${suffix}`,
        name: `Integration product ${suffix}`,
        category: 'Test',
        unit: 'unit',
        sellingPrice: '10.00',
      },
    });
    const supplier = await harness.prisma.supplier.create({
      data: { code: `IT-SUP-${suffix}`, name: `Integration supplier ${suffix}` },
    });
    const user = await harness.prisma.user.create({
      data: {
        email: `it-${suffix}@erp.local`,
        name: `Integration staff ${suffix}`,
        role: 'STAFF',
        assignedStoreId: store.id,
        passwordHash: 'x',
      },
    });
    ids.storeId = store.id;
    ids.productId = product.id;
    ids.supplierId = supplier.id;
    ids.userId = user.id;
    staff = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: 'STAFF',
      assignedStoreId: store.id,
    };

    // A second store and a STAFF user pinned to it. This user is the store-scope outsider: their
    // assigned store is not the fixture PO's destination, so a receive against that PO must be
    // rejected (#10). Mirrors staff_b02 (B02) vs PO-DEMO-001 (destination B01).
    const otherStore = await harness.prisma.store.create({
      data: { code: `IT-OTHER-${suffix}`, name: `Integration other ${suffix}` },
    });
    const outsider = await harness.prisma.user.create({
      data: {
        email: `it-outsider-${suffix}@erp.local`,
        name: `Integration outsider ${suffix}`,
        role: 'STAFF',
        assignedStoreId: otherStore.id,
        passwordHash: 'x',
      },
    });
    ids.otherStoreId = otherStore.id;
    ids.outsiderUserId = outsider.id;
    outsiderStaff = {
      id: outsider.id,
      email: outsider.email,
      name: outsider.name,
      role: 'STAFF',
      assignedStoreId: otherStore.id,
    };

    // Open the store at 10 of the product via the ledger, as the Section 8 B01 opening does.
    await harness.prisma.stockBalance.create({
      data: { productId: product.id, storeId: store.id, quantity: 10 },
    });
    await harness.prisma.stockMovement.create({
      data: {
        productId: product.id,
        storeId: store.id,
        qtyChange: 10,
        balanceBefore: 0,
        balanceAfter: 10,
        type: 'OPENING',
        sourceDocument: 'OPENING',
        actorId: null,
      },
    });
  });

  afterAll(async () => {
    if (!harness) return;
    await harness.prisma.goodsReceipt.deleteMany({ where: { storeId: ids.storeId } });
    await harness.prisma.purchaseOrder.deleteMany({ where: { storeId: ids.storeId } });
    await harness.prisma.stockMovement.deleteMany({ where: { productId: ids.productId } });
    await harness.prisma.stockBalance.deleteMany({ where: { productId: ids.productId } });
    await harness.prisma.user.deleteMany({ where: { id: ids.userId } });
    await harness.prisma.user.deleteMany({ where: { id: ids.outsiderUserId } });
    await harness.prisma.supplier.deleteMany({ where: { id: ids.supplierId } });
    await harness.prisma.product.deleteMany({ where: { id: ids.productId } });
    await harness.prisma.store.deleteMany({ where: { id: ids.storeId } });
    await harness.prisma.store.deleteMany({ where: { id: ids.otherStoreId } });
    await harness.close();
  });

  // AC-01: staff receives 8 of 20 against an Approved PO into a store opening at 10 → stock 18,
  // outstanding 12, PARTIALLY_RECEIVED, exactly one receipt and one GOODS_RECEIPT movement for it.
  it('receives 8 of 20: stock 18, outstanding 12, PARTIALLY_RECEIVED, exactly one receipt + movement', async () => {
    const order = await seedApprovedOrder(20);

    const receipt = await call(controller.receive(staff), {
      purchaseOrderId: order.id,
      lines: [{ purchaseOrderLineId: ids.purchaseOrderLineId, quantity: 8 }],
    });

    // Exactly one receipt with one line was written for this order.
    expect(receipt.number).toMatch(/^GR-/);
    expect(receipt.lines).toHaveLength(1);
    const receipts = await harness.prisma.goodsReceipt.findMany({
      where: { purchaseOrderId: order.id },
    });
    expect(receipts).toHaveLength(1);

    // Destination-store balance rose from 10 to 18.
    const balance = await harness.prisma.stockBalance.findUnique({
      where: { productId_storeId: { productId: ids.productId, storeId: ids.storeId } },
    });
    expect(balance?.quantity).toBe(18);

    // Exactly one GOODS_RECEIPT movement, carrying the receipt number as its source document.
    const movements = await harness.prisma.stockMovement.findMany({
      where: { productId: ids.productId, type: 'GOODS_RECEIPT' },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      qtyChange: 8,
      balanceBefore: 10,
      balanceAfter: 18,
      sourceDocument: receipt.number,
      actorId: ids.userId,
    });

    // The order is PARTIALLY_RECEIVED with 12 outstanding on the view.
    const reread = await harness.prisma.purchaseOrder.findUnique({ where: { id: order.id } });
    expect(reread?.status).toBe('PARTIALLY_RECEIVED');
    const view = await call(controller.receivable(staff), { purchaseOrderId: order.id });
    expect(view.lines[0]).toMatchObject({ ordered: 20, received: 8, outstanding: 12 });
  });

  it('completes the order when the remaining outstanding is received', async () => {
    const order = await seedApprovedOrder(5);

    await call(controller.receive(staff), {
      purchaseOrderId: order.id,
      lines: [{ purchaseOrderLineId: ids.purchaseOrderLineId, quantity: 5 }],
    });

    const reread = await harness.prisma.purchaseOrder.findUnique({ where: { id: order.id } });
    expect(reread?.status).toBe('COMPLETED');
    const view = await call(controller.receivable(staff), { purchaseOrderId: order.id });
    expect(view.lines[0]).toMatchObject({ ordered: 5, received: 5, outstanding: 0 });
  });

  it('rejects an over-receive and writes neither a receipt nor a movement (atomic)', async () => {
    const order = await seedApprovedOrder(5);
    const movementsBefore = await harness.prisma.stockMovement.count({
      where: { productId: ids.productId, type: 'GOODS_RECEIPT' },
    });

    await expect(
      call(controller.receive(staff), {
        purchaseOrderId: order.id,
        lines: [{ purchaseOrderLineId: ids.purchaseOrderLineId, quantity: 6 }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: GR_OVER_RECEIVE_MESSAGE });

    const receipts = await harness.prisma.goodsReceipt.findMany({
      where: { purchaseOrderId: order.id },
    });
    expect(receipts).toHaveLength(0);
    const movementsAfter = await harness.prisma.stockMovement.count({
      where: { productId: ids.productId, type: 'GOODS_RECEIPT' },
    });
    expect(movementsAfter).toBe(movementsBefore);
    const reread = await harness.prisma.purchaseOrder.findUnique({ where: { id: order.id } });
    expect(reread?.status).toBe('APPROVED');
  });

  // AC-04 / GR-01 (#10, store-scope slice over real Postgres): a STAFF user whose assigned store is
  // not the PO's destination is rejected, and the rejection leaves the database untouched — no
  // GoodsReceipt, no StockMovement, and the PO status unchanged. The destination store is derived
  // from the order, never from the request body, so there is no body store to spoof. This is the
  // Seam-2 half of the demo: a direct receive by the outsider against the fixture PO is refused and
  // nothing is written.
  it('rejects a cross-store receive and writes neither a receipt nor a movement, PO unchanged (AC-04)', async () => {
    const order = await seedApprovedOrder(20);

    const receiptsBefore = await harness.prisma.goodsReceipt.count({
      where: { purchaseOrderId: order.id },
    });
    const movementsBefore = await harness.prisma.stockMovement.count({
      where: { productId: ids.productId, type: 'GOODS_RECEIPT' },
    });
    const balanceBefore = await harness.prisma.stockBalance.findUnique({
      where: { productId_storeId: { productId: ids.productId, storeId: ids.storeId } },
    });

    await expect(
      call(controller.receive(outsiderStaff), {
        purchaseOrderId: order.id,
        lines: [{ purchaseOrderLineId: ids.purchaseOrderLineId, quantity: 8 }],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', message: STORE_SCOPE_FORBIDDEN_MESSAGE });

    // No receipt was written for this order.
    const receiptsAfter = await harness.prisma.goodsReceipt.count({
      where: { purchaseOrderId: order.id },
    });
    expect(receiptsAfter).toBe(receiptsBefore);
    // No goods-receipt movement was appended for the product.
    const movementsAfter = await harness.prisma.stockMovement.count({
      where: { productId: ids.productId, type: 'GOODS_RECEIPT' },
    });
    expect(movementsAfter).toBe(movementsBefore);
    // The destination-store balance is unchanged.
    const balanceAfter = await harness.prisma.stockBalance.findUnique({
      where: { productId_storeId: { productId: ids.productId, storeId: ids.storeId } },
    });
    expect(balanceAfter?.quantity).toBe(balanceBefore?.quantity);
    // The PO is still APPROVED — the status machine never advanced.
    const reread = await harness.prisma.purchaseOrder.findUnique({ where: { id: order.id } });
    expect(reread?.status).toBe('APPROVED');
  });
});

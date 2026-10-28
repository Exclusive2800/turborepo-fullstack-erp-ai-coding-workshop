import {
  GR_OVER_RECEIVE_MESSAGE,
  STORE_SCOPE_FORBIDDEN_MESSAGE,
  type Whoami,
} from '@erp/contracts';
import { call } from '@orpc/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
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

  // ─── #11: idempotency, over-receive at the DB level, concurrency ──────────────────────────────
  //
  // Unlike the #9 tests above, these assert absolute balances and exact receipt/movement counts, so
  // each one needs an isolated fixture: its own product, store, STAFF user and Approved PO, with the
  // store opened at 10 of the product (the Section 8 SKU001 start). Sharing the top-level fixture
  // would make the assertions depend on test order. `seedScenario` builds that isolation and returns
  // everything a scenario needs; the ids are tracked for teardown.
  const scenarioProductIds: string[] = [];
  const scenarioStoreIds: string[] = [];
  const scenarioUserIds: string[] = [];

  async function seedScenario(ordered: number): Promise<{
    staffUser: Whoami;
    orderId: string;
    purchaseOrderLineId: string;
    productId: string;
    storeId: string;
    balance: () => Promise<number | undefined>;
    movements: () => Promise<number>;
  }> {
    const s = `gr11-${randomUUID()}`;
    const store = await harness.prisma.store.create({ data: { code: `S-${s}`, name: s } });
    const product = await harness.prisma.product.create({
      data: { sku: `SKU-${s}`, name: s, category: 'Test', unit: 'unit', sellingPrice: '10.00' },
    });
    const supplier = await harness.prisma.supplier.create({
      data: { code: `SUP-${s}`, name: s },
    });
    const user = await harness.prisma.user.create({
      data: {
        email: `${s}@erp.local`,
        name: s,
        role: 'STAFF',
        assignedStoreId: store.id,
        passwordHash: 'x',
      },
    });
    scenarioProductIds.push(product.id);
    scenarioStoreIds.push(store.id);
    scenarioUserIds.push(user.id);

    // Open the store at 10 via the ledger, as the Section 8 B01 opening does.
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

    const order = await harness.prisma.purchaseOrder.create({
      data: {
        number: `PO-${s}`,
        status: 'APPROVED',
        supplierId: supplier.id,
        storeId: store.id,
        expectedReceiptDate: new Date('2026-02-01T00:00:00.000Z'),
        total: (ordered * 45).toFixed(2),
        createdById: user.id,
        lines: {
          create: [
            {
              productId: product.id,
              sku: `SKU-${s}`,
              productName: s,
              quantity: ordered,
              unitPrice: '45.00',
              lineTotal: (ordered * 45).toFixed(2),
            },
          ],
        },
      },
      include: { lines: true },
    });

    return {
      staffUser: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: 'STAFF',
        assignedStoreId: store.id,
      },
      orderId: order.id,
      purchaseOrderLineId: order.lines[0]!.id,
      productId: product.id,
      storeId: store.id,
      async balance() {
        const b = await harness.prisma.stockBalance.findUnique({
          where: { productId_storeId: { productId: product.id, storeId: store.id } },
        });
        return b?.quantity;
      },
      async movements() {
        return harness.prisma.stockMovement.count({
          where: { productId: product.id, type: 'GOODS_RECEIPT' },
        });
      },
    };
  }

  afterAll(async () => {
    // Tear down every #11 scenario fixture (the top-level afterAll above handles the #9 fixture).
    await harness.prisma.goodsReceipt.deleteMany({ where: { storeId: { in: scenarioStoreIds } } });
    await harness.prisma.purchaseOrder.deleteMany({ where: { storeId: { in: scenarioStoreIds } } });
    await harness.prisma.stockMovement.deleteMany({
      where: { productId: { in: scenarioProductIds } },
    });
    await harness.prisma.stockBalance.deleteMany({
      where: { productId: { in: scenarioProductIds } },
    });
    await harness.prisma.user.deleteMany({ where: { id: { in: scenarioUserIds } } });
    await harness.prisma.product.deleteMany({ where: { id: { in: scenarioProductIds } } });
    await harness.prisma.store.deleteMany({ where: { id: { in: scenarioStoreIds } } });
    await harness.prisma.supplier.deleteMany({ where: { code: { startsWith: 'SUP-gr11-' } } });
  });

  // AC-02 (GR-04, Seam 2): from the Section 8 start (opening 10, ordered 20), receiving 8 then
  // resending the SAME request (same idempotency key) returns the original receipt — same id and
  // number — with stock still 18 and cumulative received still 8. The replay writes no second
  // receipt and no second movement: the unique key is the source of truth.
  it('replays the same idempotency key: original receipt, stock 18, cumulative 8, no second movement (AC-02)', async () => {
    const s = await seedScenario(20);
    const key = `idem-${randomUUID()}`;
    const request = {
      purchaseOrderId: s.orderId,
      lines: [{ purchaseOrderLineId: s.purchaseOrderLineId, quantity: 8 }],
      idempotencyKey: key,
    };

    const first = await call(controller.receive(s.staffUser), request);
    const replay = await call(controller.receive(s.staffUser), request);

    // The replay is the very same receipt, not a new one.
    expect(replay.id).toBe(first.id);
    expect(replay.number).toBe(first.number);

    // Exactly one receipt and one GOODS_RECEIPT movement exist for this order/product.
    const receipts = await harness.prisma.goodsReceipt.findMany({
      where: { purchaseOrderId: s.orderId },
    });
    expect(receipts).toHaveLength(1);
    expect(await s.movements()).toBe(1);

    // Stock rose exactly once (10 → 18) and cumulative received is 8, not 16.
    expect(await s.balance()).toBe(18);
    const view = await call(controller.receivable(s.staffUser), { purchaseOrderId: s.orderId });
    expect(view.lines[0]).toMatchObject({ ordered: 20, received: 8, outstanding: 12 });
  });

  // GR-04 (Seam 2): a DIFFERENT key against the same order is a genuine second receipt. From
  // opening 10, receiving 8 then another 5 under a fresh key yields two receipts, two movements and
  // stock 23 (10 + 8 + 5).
  it('creates a genuine second receipt for a fresh key and raises stock again', async () => {
    const s = await seedScenario(20);

    const first = await call(controller.receive(s.staffUser), {
      purchaseOrderId: s.orderId,
      lines: [{ purchaseOrderLineId: s.purchaseOrderLineId, quantity: 8 }],
      idempotencyKey: `idem-${randomUUID()}`,
    });
    const second = await call(controller.receive(s.staffUser), {
      purchaseOrderId: s.orderId,
      lines: [{ purchaseOrderLineId: s.purchaseOrderLineId, quantity: 5 }],
      idempotencyKey: `idem-${randomUUID()}`,
    });

    expect(second.id).not.toBe(first.id);
    expect(second.number).not.toBe(first.number);
    const receipts = await harness.prisma.goodsReceipt.findMany({
      where: { purchaseOrderId: s.orderId },
    });
    expect(receipts).toHaveLength(2);
    expect(await s.balance()).toBe(23);
    const view = await call(controller.receivable(s.staffUser), { purchaseOrderId: s.orderId });
    expect(view.lines[0]).toMatchObject({ ordered: 20, received: 13, outstanding: 7 });
  });

  // AC-03 (GR-05, Seam 2): from the Section 8 start (opening 10, ordered 20), a request to receive
  // 21 of SKU001 is rejected — cumulative received (21) would exceed ordered (20). No receipt, no
  // movement, stock stays 10, and the order stays APPROVED.
  it('rejects receiving 21 of an order for 20: no receipt, no movement, stock 10, status APPROVED (AC-03)', async () => {
    const s = await seedScenario(20);

    await expect(
      call(controller.receive(s.staffUser), {
        purchaseOrderId: s.orderId,
        lines: [{ purchaseOrderLineId: s.purchaseOrderLineId, quantity: 21 }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: GR_OVER_RECEIVE_MESSAGE });

    const receipts = await harness.prisma.goodsReceipt.findMany({
      where: { purchaseOrderId: s.orderId },
    });
    expect(receipts).toHaveLength(0);
    expect(await s.movements()).toBe(0);
    expect(await s.balance()).toBe(10);
    const reread = await harness.prisma.purchaseOrder.findUnique({ where: { id: s.orderId } });
    expect(reread?.status).toBe('APPROVED');
  });

  // GR-04 concurrency (Seam 2, PRIMARY): two requests carrying the SAME idempotency key fired in
  // parallel against the same order resolve to exactly one receipt. The unique constraint lets only
  // one insert commit; the loser replays the winner. Cumulative received is the single quantity, not
  // double, and stock rose once.
  it('two concurrent requests with the same key create exactly one receipt and raise stock once', async () => {
    const s = await seedScenario(20);
    const key = `idem-${randomUUID()}`;
    const request = {
      purchaseOrderId: s.orderId,
      lines: [{ purchaseOrderLineId: s.purchaseOrderLineId, quantity: 8 }],
      idempotencyKey: key,
    };

    const [a, b] = await Promise.all([
      call(controller.receive(s.staffUser), request),
      call(controller.receive(s.staffUser), request),
    ]);

    // Both callers saw the same single receipt.
    expect(a.id).toBe(b.id);
    const receipts = await harness.prisma.goodsReceipt.findMany({
      where: { purchaseOrderId: s.orderId },
    });
    expect(receipts).toHaveLength(1);
    expect(await s.movements()).toBe(1);
    expect(await s.balance()).toBe(18);
  });

  // GR-04/GR-05 concurrency (Seam 2, PRIMARY): two requests with DIFFERENT keys, each for the whole
  // outstanding quantity (20) of an order for 20, fired in parallel. Cumulative received can never
  // exceed ordered: at most the outstanding total (20) is received, so exactly one commits and the
  // other is rejected as an over-receive. The balance rises by at most the ordered quantity.
  it('two concurrent full-outstanding receipts with different keys never exceed ordered (exactly one wins)', async () => {
    const s = await seedScenario(20);
    const makeRequest = () => ({
      purchaseOrderId: s.orderId,
      lines: [{ purchaseOrderLineId: s.purchaseOrderLineId, quantity: 20 }],
      idempotencyKey: `idem-${randomUUID()}`,
    });

    const results = await Promise.allSettled([
      call(controller.receive(s.staffUser), makeRequest()),
      call(controller.receive(s.staffUser), makeRequest()),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one receipt committed; the other lost on the cumulative/over-receive check.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const receipts = await harness.prisma.goodsReceipt.findMany({
      where: { purchaseOrderId: s.orderId },
    });
    expect(receipts).toHaveLength(1);

    // Cumulative received never exceeded ordered: stock rose by at most 20 (10 → 30), never 50.
    expect(await s.balance()).toBe(30);
    const view = await call(controller.receivable(s.staffUser), { purchaseOrderId: s.orderId });
    expect(view.lines[0]!.received).toBeLessThanOrEqual(20);
    expect(view.lines[0]).toMatchObject({ ordered: 20, received: 20, outstanding: 0 });
  });

  // GR-04 (Seam 2): the key is globally unique, so reusing it against a DIFFERENT order replays the
  // original receipt rather than creating a second one or erroring. This closes the cross-order
  // reuse path (the P2002 loser resolves to the winner by key alone) and matches the global unique
  // constraint the schema declares — the mechanism sale confirmation (#14) reuses.
  it('replays the original receipt when the same key is reused against a different order', async () => {
    const first = await seedScenario(20);
    const second = await seedScenario(20);
    const key = `idem-${randomUUID()}`;

    const original = await call(controller.receive(first.staffUser), {
      purchaseOrderId: first.orderId,
      lines: [{ purchaseOrderLineId: first.purchaseOrderLineId, quantity: 8 }],
      idempotencyKey: key,
    });

    // The same key against the second order returns the FIRST order's receipt, writes nothing new,
    // and leaves the second order untouched.
    const replay = await call(controller.receive(second.staffUser), {
      purchaseOrderId: second.orderId,
      lines: [{ purchaseOrderLineId: second.purchaseOrderLineId, quantity: 5 }],
      idempotencyKey: key,
    });

    expect(replay.id).toBe(original.id);
    expect(replay.purchaseOrderId).toBe(first.orderId);

    const secondReceipts = await harness.prisma.goodsReceipt.findMany({
      where: { purchaseOrderId: second.orderId },
    });
    expect(secondReceipts).toHaveLength(0);
    expect(await second.balance()).toBe(10);
    expect(await second.movements()).toBe(0);
  });

  // Q-02 (#12, Seam 2): a product deactivated AFTER its PO is approved can still be received against
  // that approved order, and the receipt posts stock and advances the PO exactly as for an active
  // product. This is the integrity half of the clarification: MD-02's active-only rule guards new
  // documents (proven on the purchase-orders spec, PRODUCT_INACTIVE_MESSAGE), while an approved
  // commitment is still fulfilled. The scenario opens the store at 10, approves an order for 20,
  // flips the product to inactive, then receives 8 — stock must rise to 18, one receipt and one
  // GOODS_RECEIPT movement exist, and the order is PARTIALLY_RECEIVED (user story 38, spec #1 Q-02).
  it('receives against an approved PO whose product was deactivated after approval: stock 18, one receipt, PARTIALLY_RECEIVED (Q-02)', async () => {
    const s = await seedScenario(20);

    // Deactivate the product after the order is approved — this is the exact Q-02 sequence.
    await harness.prisma.product.update({
      where: { id: s.productId },
      data: { active: false },
    });
    const deactivated = await harness.prisma.product.findUnique({ where: { id: s.productId } });
    expect(deactivated?.active).toBe(false);

    // Receiving still succeeds against the approved line.
    const receipt = await call(controller.receive(s.staffUser), {
      purchaseOrderId: s.orderId,
      lines: [{ purchaseOrderLineId: s.purchaseOrderLineId, quantity: 8 }],
    });

    expect(receipt.number).toMatch(/^GR-/);
    expect(receipt.lines).toHaveLength(1);

    // Stock rose 10 → 18, exactly one receipt and one movement, order PARTIALLY_RECEIVED.
    expect(await s.balance()).toBe(18);
    expect(await s.movements()).toBe(1);
    const receipts = await harness.prisma.goodsReceipt.findMany({
      where: { purchaseOrderId: s.orderId },
    });
    expect(receipts).toHaveLength(1);
    const reread = await harness.prisma.purchaseOrder.findUnique({ where: { id: s.orderId } });
    expect(reread?.status).toBe('PARTIALLY_RECEIVED');
    const view = await call(controller.receivable(s.staffUser), { purchaseOrderId: s.orderId });
    expect(view.lines[0]).toMatchObject({ ordered: 20, received: 8, outstanding: 12 });
  });
});

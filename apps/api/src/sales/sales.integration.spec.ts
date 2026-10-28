import {
  saleInsufficientStockMessage,
  SALE_NOT_CONFIRMABLE_MESSAGE,
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
import { SalesController } from './sales.controller.js';

// Seam 2 (#14): the real sale-confirm handler over a real Postgres. Proves the behaviours a mocked
// PrismaService cannot — atomic post-and-deduct, the never-negative stock validation, the running
// balance and the DRAFT→CONFIRMED transition all commit together — and idempotent retry (the unique
// key is the source of truth, under concurrency too). It walks the #14 Demo end to end: AC-05
// (selling 11 of SKU001 against stock 10 fails, names SKU001, writes no sale and no deduction) and
// AC-06 (selling 2 of SKU001 + 1 of SKU002 totals 155.00, balances become 8 and 4, and resending
// the same key changes nothing further). Each scenario seeds its own store, products, STAFF user and
// opening balances with a unique suffix so it never collides with the Section 8 fixture or a
// parallel spec. When no database is reachable the whole suite skips loudly, matching #5's harness.
const databaseReachable = await isDatabaseReachable();

describe.skipIf(!databaseReachable)('SalesController confirm (real Postgres)', () => {
  let harness: IntegrationHarness;
  let controller: SalesController;

  const scenarioProductIds: string[] = [];
  const scenarioStoreIds: string[] = [];
  const scenarioUserIds: string[] = [];

  interface Scenario {
    staffUser: Whoami;
    storeId: string;
    /** SKU001-equivalent: selling price 60, opening `sku1Opening`. */
    product1Id: string;
    sku1: string;
    /** SKU002-equivalent: selling price 35, opening `sku2Opening`. */
    product2Id: string;
    sku2: string;
    balance(productId: string): Promise<number | undefined>;
    saleMovements(productId: string): Promise<number>;
  }

  /** Seed a store opened at `sku1Opening`/`sku2Opening` of two priced products, plus a STAFF user. */
  async function seedScenario(sku1Opening: number, sku2Opening: number): Promise<Scenario> {
    const s = `sal14-${randomUUID()}`;
    const store = await harness.prisma.store.create({ data: { code: `S-${s}`, name: s } });
    const product1 = await harness.prisma.product.create({
      data: {
        sku: `SKU1-${s}`,
        name: `${s} one`,
        category: 'Test',
        unit: 'unit',
        sellingPrice: '60.00',
      },
    });
    const product2 = await harness.prisma.product.create({
      data: {
        sku: `SKU2-${s}`,
        name: `${s} two`,
        category: 'Test',
        unit: 'unit',
        sellingPrice: '35.00',
      },
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
    scenarioProductIds.push(product1.id, product2.id);
    scenarioStoreIds.push(store.id);
    scenarioUserIds.push(user.id);

    // Open each product in the store via the ledger, as the Section 8 B01 opening does.
    for (const [product, opening] of [
      [product1, sku1Opening],
      [product2, sku2Opening],
    ] as const) {
      await harness.prisma.stockBalance.create({
        data: { productId: product.id, storeId: store.id, quantity: opening },
      });
      await harness.prisma.stockMovement.create({
        data: {
          productId: product.id,
          storeId: store.id,
          qtyChange: opening,
          balanceBefore: 0,
          balanceAfter: opening,
          type: 'OPENING',
          sourceDocument: 'OPENING',
          actorId: null,
        },
      });
    }

    return {
      staffUser: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: 'STAFF',
        assignedStoreId: store.id,
      },
      storeId: store.id,
      product1Id: product1.id,
      sku1: product1.sku,
      product2Id: product2.id,
      sku2: product2.sku,
      async balance(productId: string) {
        const b = await harness.prisma.stockBalance.findUnique({
          where: { productId_storeId: { productId, storeId: store.id } },
        });
        return b?.quantity;
      },
      async saleMovements(productId: string) {
        return harness.prisma.stockMovement.count({ where: { productId, type: 'SALE' } });
      },
    };
  }

  /** Create a DRAFT sale directly for `lines`, snapshotting each product's current selling price. */
  async function seedDraftSale(
    scenario: Scenario,
    lines: { productId: string; quantity: number }[],
  ): Promise<string> {
    const products = await harness.prisma.product.findMany({
      where: { id: { in: lines.map((l) => l.productId) } },
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    const lineData = lines.map((line) => {
      const product = byId.get(line.productId)!;
      const unitPrice = product.sellingPrice.toFixed(2);
      return {
        productId: line.productId,
        sku: product.sku,
        productName: product.name,
        quantity: line.quantity,
        unitPrice,
        lineTotal: (line.quantity * Number(unitPrice)).toFixed(2),
      };
    });
    const total = lineData.reduce((sum, l) => sum + Number(l.lineTotal), 0).toFixed(2);
    const sale = await harness.prisma.sale.create({
      data: {
        status: 'DRAFT',
        storeId: scenario.storeId,
        createdById: scenario.staffUser.id,
        total,
        lines: { create: lineData },
      },
    });
    return sale.id;
  }

  beforeAll(async () => {
    harness = createIntegrationHarness();
    const posting = new StockPostingService(harness.prisma as unknown as PrismaService);
    controller = new SalesController(harness.prisma as unknown as PrismaService, posting);
  });

  afterAll(async () => {
    if (!harness) return;
    await harness.prisma.sale.deleteMany({ where: { storeId: { in: scenarioStoreIds } } });
    await harness.prisma.stockMovement.deleteMany({
      where: { productId: { in: scenarioProductIds } },
    });
    await harness.prisma.stockBalance.deleteMany({
      where: { productId: { in: scenarioProductIds } },
    });
    await harness.prisma.user.deleteMany({ where: { id: { in: scenarioUserIds } } });
    await harness.prisma.product.deleteMany({ where: { id: { in: scenarioProductIds } } });
    await harness.prisma.store.deleteMany({ where: { id: { in: scenarioStoreIds } } });
    await harness.close();
  });

  // AC-05: selling 11 of SKU001 against opening 10 is rejected — the line is short. The whole
  // document is rejected, SKU001 is named, and nothing is written: the sale stays DRAFT, no SALE
  // movement exists and the balance is untouched.
  it('rejects selling 11 of SKU001 against stock 10: names SKU001, writes no sale and no deduction (AC-05)', async () => {
    const s = await seedScenario(10, 4);
    const saleId = await seedDraftSale(s, [{ productId: s.product1Id, quantity: 11 }]);

    await expect(call(controller.confirm(s.staffUser), { id: saleId })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: saleInsufficientStockMessage([s.sku1]),
    });

    // The sale was never confirmed and no deduction was posted.
    const reread = await harness.prisma.sale.findUnique({ where: { id: saleId } });
    expect(reread?.status).toBe('DRAFT');
    expect(reread?.documentNumber).toBeNull();
    expect(await s.saleMovements(s.product1Id)).toBe(0);
    expect(await s.balance(s.product1Id)).toBe(10);
  });

  // AC-06: selling 2 of SKU001 (@60) + 1 of SKU002 (@35) totals 155.00; confirmation deducts stock
  // to 8 and 4, allocates a unique SAL number, posts one SALE movement per line and transitions the
  // sale to CONFIRMED — all atomically. Resending the SAME idempotency key returns the original
  // confirmed sale and changes nothing further (no second sale, no second deduction).
  it('confirms 2×SKU001 + 1×SKU002: total 155.00, balances 8 and 4, atomic post; resending the key changes nothing (AC-06)', async () => {
    const s = await seedScenario(10, 5);
    const saleId = await seedDraftSale(s, [
      { productId: s.product1Id, quantity: 2 },
      { productId: s.product2Id, quantity: 1 },
    ]);
    const key = `idem-${randomUUID()}`;

    const confirmed = await call(controller.confirm(s.staffUser), {
      id: saleId,
      idempotencyKey: key,
    });

    // The document total is 2×60 + 1×35 = 155.00, and it is now CONFIRMED with a SAL number.
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.total).toBe('155.00');
    expect(confirmed.documentNumber).toMatch(/^SAL-/);
    expect(confirmed.confirmedAt).not.toBeNull();

    // Balances dropped from 10→8 and 5→4.
    expect(await s.balance(s.product1Id)).toBe(8);
    expect(await s.balance(s.product2Id)).toBe(4);

    // Exactly one SALE movement per product, each carrying the SAL number and a negative qtyChange.
    expect(await s.saleMovements(s.product1Id)).toBe(1);
    expect(await s.saleMovements(s.product2Id)).toBe(1);
    const movement1 = await harness.prisma.stockMovement.findFirst({
      where: { productId: s.product1Id, type: 'SALE' },
    });
    expect(movement1).toMatchObject({
      qtyChange: -2,
      balanceBefore: 10,
      balanceAfter: 8,
      sourceDocument: confirmed.documentNumber,
      actorId: s.staffUser.id,
    });

    // Resend the same key: the original confirmed sale comes back and nothing is written again.
    const replay = await call(controller.confirm(s.staffUser), { id: saleId, idempotencyKey: key });
    expect(replay.id).toBe(confirmed.id);
    expect(replay.documentNumber).toBe(confirmed.documentNumber);
    expect(await s.balance(s.product1Id)).toBe(8);
    expect(await s.balance(s.product2Id)).toBe(4);
    expect(await s.saleMovements(s.product1Id)).toBe(1);
    expect(await s.saleMovements(s.product2Id)).toBe(1);
  });

  // A confirmed sale cannot be confirmed again without its key: the sale is no longer a Draft.
  it('rejects re-confirming an already-confirmed sale without the original key', async () => {
    const s = await seedScenario(10, 5);
    const saleId = await seedDraftSale(s, [{ productId: s.product1Id, quantity: 2 }]);

    await call(controller.confirm(s.staffUser), {
      id: saleId,
      idempotencyKey: `idem-${randomUUID()}`,
    });

    await expect(call(controller.confirm(s.staffUser), { id: saleId })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: SALE_NOT_CONFIRMABLE_MESSAGE,
    });
    // Still deducted exactly once.
    expect(await s.balance(s.product1Id)).toBe(8);
    expect(await s.saleMovements(s.product1Id)).toBe(1);
  });

  // Concurrency (SAL, Seam 2): two requests carrying the SAME key fired in parallel resolve to
  // exactly one confirmation. The unique key lets only one commit; the loser replays the winner.
  // Stock is deducted once.
  it('two concurrent requests with the same key confirm once and deduct stock once', async () => {
    const s = await seedScenario(10, 5);
    const saleId = await seedDraftSale(s, [{ productId: s.product1Id, quantity: 2 }]);
    const key = `idem-${randomUUID()}`;
    const request = { id: saleId, idempotencyKey: key };

    const [a, b] = await Promise.all([
      call(controller.confirm(s.staffUser), request),
      call(controller.confirm(s.staffUser), request),
    ]);

    // Both callers saw the same single confirmed sale.
    expect(a.id).toBe(b.id);
    expect(a.documentNumber).toBe(b.documentNumber);
    // Stock dropped exactly once (10 → 8) and exactly one SALE movement exists.
    expect(await s.balance(s.product1Id)).toBe(8);
    expect(await s.saleMovements(s.product1Id)).toBe(1);
  });

  // Never-negative under exact-boundary selling: selling exactly the opening quantity succeeds and
  // drives the balance to 0, never below. A follow-up draft for one more is then rejected.
  it('sells exactly the opening quantity to zero, then rejects selling one more', async () => {
    const s = await seedScenario(3, 5);
    const exact = await seedDraftSale(s, [{ productId: s.product1Id, quantity: 3 }]);

    const confirmed = await call(controller.confirm(s.staffUser), { id: exact });
    expect(confirmed.status).toBe('CONFIRMED');
    expect(await s.balance(s.product1Id)).toBe(0);

    const oneMore = await seedDraftSale(s, [{ productId: s.product1Id, quantity: 1 }]);
    await expect(call(controller.confirm(s.staffUser), { id: oneMore })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: saleInsufficientStockMessage([s.sku1]),
    });
    expect(await s.balance(s.product1Id)).toBe(0);
  });
});

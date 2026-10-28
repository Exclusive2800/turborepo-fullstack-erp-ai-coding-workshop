import { call } from '@orpc/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../database/prisma.service.js';
import {
  createIntegrationHarness,
  type IntegrationHarness,
  isDatabaseReachable,
} from '../test/integration-harness.js';
import { ReportsController } from './reports.controller.js';

// Seam 2 (#17): the daily sales report over a real Postgres, proving the Asia/Bangkok
// reporting-day boundary against real `timestamptz` values a mocked PrismaService cannot exhibit.
// The single correctness point (user story 51): a sale confirmed near Bangkok midnight is
// attributed to the correct Bangkok reporting day. Bangkok is UTC+7 with no DST, so 23:30 on
// 2026-01-15 Bangkok is 16:30 UTC on 2026-01-15, and the next Bangkok midnight (2026-01-16 00:00
// BKK) is 17:00 UTC on 2026-01-15 — the exclusive end of the 15th. Each scenario seeds its own
// store/products with a unique suffix so it never collides with the Section 8 fixture or a parallel
// spec. When no database is reachable the whole suite skips loudly, matching #5's harness.
const databaseReachable = await isDatabaseReachable();

describe.skipIf(!databaseReachable)('ReportsController dailySales (real Postgres)', () => {
  let harness: IntegrationHarness;
  let controller: ReportsController;

  const scenarioProductIds: string[] = [];
  const scenarioStoreIds: string[] = [];
  const scenarioSaleIds: string[] = [];

  interface Scenario {
    storeId: string;
    productId: string;
    sku: string;
    userId: string;
    /** Create a CONFIRMED sale of `quantity` @60, confirmed at the given UTC instant. */
    confirmSale(confirmedAtUtc: string, quantity: number): Promise<string>;
  }

  async function seedScenario(): Promise<Scenario> {
    const s = `rpt17-${randomUUID()}`;
    const store = await harness.prisma.store.create({ data: { code: `S-${s}`, name: s } });
    const product = await harness.prisma.product.create({
      data: {
        sku: `SKU-${s}`,
        name: `${s} product`,
        category: 'Test',
        unit: 'unit',
        sellingPrice: '60.00',
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
    scenarioProductIds.push(product.id);
    scenarioStoreIds.push(store.id);

    return {
      storeId: store.id,
      productId: product.id,
      sku: product.sku,
      userId: user.id,
      async confirmSale(confirmedAtUtc: string, quantity: number) {
        const lineTotal = (quantity * 60).toFixed(2);
        const sale = await harness.prisma.sale.create({
          data: {
            status: 'CONFIRMED',
            storeId: store.id,
            createdById: user.id,
            total: lineTotal,
            documentNumber: `SAL-${randomUUID()}`,
            confirmedAt: new Date(confirmedAtUtc),
            lines: {
              create: [
                {
                  productId: product.id,
                  sku: product.sku,
                  productName: `${s} product`,
                  quantity,
                  unitPrice: '60.00',
                  lineTotal,
                },
              ],
            },
          },
        });
        scenarioSaleIds.push(sale.id);
        return sale.id;
      },
    };
  }

  beforeAll(async () => {
    harness = createIntegrationHarness();
    controller = new ReportsController(harness.prisma as unknown as PrismaService);
  });

  afterAll(async () => {
    if (!harness) return;
    await harness.prisma.sale.deleteMany({ where: { storeId: { in: scenarioStoreIds } } });
    await harness.prisma.user.deleteMany({ where: { assignedStoreId: { in: scenarioStoreIds } } });
    await harness.prisma.product.deleteMany({ where: { id: { in: scenarioProductIds } } });
    await harness.prisma.store.deleteMany({ where: { id: { in: scenarioStoreIds } } });
    await harness.close();
  });

  // The midnight-edge test: a sale confirmed at 23:30 Bangkok on 2026-01-15 (16:30 UTC) belongs to
  // the 15th's report, not the 16th's. A second sale confirmed at exactly 2026-01-16 00:00 Bangkok
  // (17:00 UTC on the 15th) belongs to the 16th, proving the end boundary is exclusive.
  it('attributes a 23:30 Bangkok sale to that Bangkok day and the next Bangkok midnight to the next day', async () => {
    const s = await seedScenario();
    // 23:30 Bangkok on 2026-01-15 == 16:30 UTC on 2026-01-15.
    await s.confirmSale('2026-01-15T16:30:00.000Z', 2);
    // 00:00 Bangkok on 2026-01-16 == 17:00 UTC on 2026-01-15 — the exclusive boundary.
    await s.confirmSale('2026-01-15T17:00:00.000Z', 5);

    const day15 = await call(controller.dailySales(), {
      from: '2026-01-15',
      to: '2026-01-15',
      storeId: s.storeId,
    });
    // Only the 23:30 sale lands on the 15th: one document, 2 units, 120.00.
    expect(day15.documentCount).toBe(1);
    expect(day15.unitsSold).toBe(2);
    expect(day15.amount).toBe('120.00');

    const day16 = await call(controller.dailySales(), {
      from: '2026-01-16',
      to: '2026-01-16',
      storeId: s.storeId,
    });
    // The midnight sale lands on the 16th: one document, 5 units, 300.00.
    expect(day16.documentCount).toBe(1);
    expect(day16.unitsSold).toBe(5);
    expect(day16.amount).toBe('300.00');
  });

  // A day with no matching confirmed sales returns zero totals (AC-08 sales-zero half).
  it('returns zero totals for a day with no confirmed sales', async () => {
    const s = await seedScenario();
    await s.confirmSale('2026-01-15T16:30:00.000Z', 2);

    const empty = await call(controller.dailySales(), {
      from: '2026-02-01',
      to: '2026-02-01',
      storeId: s.storeId,
    });
    expect(empty).toMatchObject({ documentCount: 0, unitsSold: 0, amount: '0.00' });
  });

  // Only CONFIRMED sales count: a DRAFT sale (no confirmedAt) in the same store never appears.
  it('ignores DRAFT sales and sales outside the store', async () => {
    const s = await seedScenario();
    await s.confirmSale('2026-01-15T16:30:00.000Z', 2);
    // A DRAFT sale in the same store on the same day must not be counted.
    await harness.prisma.sale.create({
      data: {
        status: 'DRAFT',
        storeId: s.storeId,
        createdById: s.userId,
        total: '600.00',
        lines: {
          create: [
            {
              productId: s.productId,
              sku: s.sku,
              productName: 'draft',
              quantity: 10,
              unitPrice: '60.00',
              lineTotal: '600.00',
            },
          ],
        },
      },
    });

    const report = await call(controller.dailySales(), {
      from: '2026-01-15',
      to: '2026-01-15',
      storeId: s.storeId,
    });
    // Only the one CONFIRMED sale of 2 units counts; the DRAFT's 10 units are excluded.
    expect(report.documentCount).toBe(1);
    expect(report.unitsSold).toBe(2);
    expect(report.amount).toBe('120.00');
  });
});

// Seam 2 (#18): the stock-on-hand and low-stock reports over a real Postgres. The single
// correctness point is the low-stock threshold boundary against real balance rows: a product at
// balance 0 with threshold 3 is low-stock (0 ≤ 3), exactly at threshold is low-stock, just above is
// not. A mocked PrismaService cannot exhibit the real `findMany` ordering + the per-store threshold
// join, so this proves the aggregation end to end. Each scenario seeds its own store/products with
// a unique suffix so it never collides with the Section 8 fixture or a parallel spec.
describe.skipIf(!databaseReachable)('ReportsController stock reports (real Postgres)', () => {
  let harness: IntegrationHarness;
  let controller: ReportsController;

  const storeIds: string[] = [];
  const productIds: string[] = [];

  /**
   * Seed one store with three products at the given on-hand quantities, each with the given reorder
   * threshold in that store (or no threshold when `threshold` is null). Writes a StockBalance row
   * per product. Returns the store id and a sku→productId map so a test can assert specific rows.
   */
  async function seedStockScenario(
    quantities: { sku: string; quantity: number; threshold: number | null }[],
  ): Promise<{ storeId: string; productBySku: Map<string, string> }> {
    const s = `rpt18-${randomUUID()}`;
    const store = await harness.prisma.store.create({ data: { code: `S-${s}`, name: s } });
    storeIds.push(store.id);
    const productBySku = new Map<string, string>();
    for (const row of quantities) {
      const product = await harness.prisma.product.create({
        data: {
          sku: `${row.sku}-${s}`,
          name: `${row.sku} ${s}`,
          category: 'Test',
          unit: 'unit',
          sellingPrice: '10.00',
        },
      });
      productIds.push(product.id);
      productBySku.set(row.sku, product.id);
      await harness.prisma.stockBalance.create({
        data: { productId: product.id, storeId: store.id, quantity: row.quantity },
      });
      if (row.threshold !== null) {
        await harness.prisma.productStoreThreshold.create({
          data: { productId: product.id, storeId: store.id, threshold: row.threshold },
        });
      }
    }
    return { storeId: store.id, productBySku };
  }

  beforeAll(async () => {
    harness = createIntegrationHarness();
    controller = new ReportsController(harness.prisma as unknown as PrismaService);
  });

  afterAll(async () => {
    if (!harness) return;
    await harness.prisma.stockMovement.deleteMany({ where: { storeId: { in: storeIds } } });
    await harness.prisma.stockBalance.deleteMany({ where: { storeId: { in: storeIds } } });
    await harness.prisma.productStoreThreshold.deleteMany({
      where: { storeId: { in: storeIds } },
    });
    await harness.prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await harness.prisma.store.deleteMany({ where: { id: { in: storeIds } } });
    await harness.close();
  });

  // Stock-on-hand keeps every matching row, zero-stock included, with its threshold and flag.
  it('stock-on-hand returns every balance for the store, keeping a zero-stock row visible', async () => {
    const { storeId } = await seedStockScenario([
      { sku: 'A', quantity: 10, threshold: 3 },
      { sku: 'B', quantity: 0, threshold: 3 },
    ]);

    const report = await call(controller.stockOnHand(), { storeId });

    expect(report.total).toBe(2);
    const zero = report.items.find((i) => i.quantity === 0);
    expect(zero, 'the zero-stock row must stay visible').toBeDefined();
    expect(zero?.lowStock).toBe(true);
    const ten = report.items.find((i) => i.quantity === 10);
    expect(ten?.lowStock).toBe(false);
  });

  // The low-stock boundary over real rows: 0 ≤ 3 included, exactly-at included, just-above excluded.
  it('low-stock includes balance 0 and exactly-at-threshold rows and excludes a just-above row', async () => {
    const { storeId, productBySku } = await seedStockScenario([
      { sku: 'ZERO', quantity: 0, threshold: 3 },
      { sku: 'AT', quantity: 3, threshold: 3 },
      { sku: 'ABOVE', quantity: 4, threshold: 3 },
    ]);

    const report = await call(controller.lowStock(), { storeId });

    const ids = new Set(report.items.map((i) => i.productId));
    expect(ids.has(productBySku.get('ZERO')!)).toBe(true);
    expect(ids.has(productBySku.get('AT')!)).toBe(true);
    expect(ids.has(productBySku.get('ABOVE')!)).toBe(false);
    expect(report.total).toBe(2);
    expect(report.items.every((i) => i.lowStock)).toBe(true);
  });

  // A product with no per-store threshold is never low-stock, even at balance 0.
  it('low-stock excludes a product with no threshold for the store', async () => {
    const { storeId } = await seedStockScenario([
      { sku: 'NOTHRESH', quantity: 0, threshold: null },
    ]);

    const report = await call(controller.lowStock(), { storeId });

    expect(report.items).toEqual([]);
    expect(report.total).toBe(0);
  });
});

// Seam 2 (#19): the movement-history report over a real Postgres. Two correctness points a mocked
// PrismaService cannot exhibit: (1) store scoping is derived from the principal — a STAFF caller
// only ever sees its assigned store, a MANAGER sees every store — against real rows in two stores;
// (2) the half-open Asia/Bangkok date range is keyed on the real `timestamptz` movement timestamp,
// so a movement at 23:30 Bangkok lands on that Bangkok day and the next midnight does not. Each
// scenario seeds its own stores/product with a unique suffix so it never collides with the Section
// 8 fixture or a parallel spec.
describe.skipIf(!databaseReachable)('ReportsController movementHistory (real Postgres)', () => {
  let harness: IntegrationHarness;
  let controller: ReportsController;

  const storeIds: string[] = [];
  const productIds: string[] = [];
  const userIds: string[] = [];

  /**
   * Seed two stores (A and B), one product, a STAFF user pinned to store A and a MANAGER, and a
   * handful of ledger movements of different types across both stores and days. Returns the ids a
   * test needs to assert scope and range.
   */
  async function seedMovementScenario() {
    const s = `rpt19-${randomUUID()}`;
    const storeA = await harness.prisma.store.create({ data: { code: `A-${s}`, name: `A ${s}` } });
    const storeB = await harness.prisma.store.create({ data: { code: `B-${s}`, name: `B ${s}` } });
    storeIds.push(storeA.id, storeB.id);
    const product = await harness.prisma.product.create({
      data: {
        sku: `SKU-${s}`,
        name: `${s} product`,
        category: 'Test',
        unit: 'unit',
        sellingPrice: '10.00',
      },
    });
    productIds.push(product.id);
    const staff = await harness.prisma.user.create({
      data: {
        email: `staff-${s}@erp.local`,
        name: `staff ${s}`,
        role: 'STAFF',
        assignedStoreId: storeA.id,
        passwordHash: 'x',
      },
    });
    const manager = await harness.prisma.user.create({
      data: { email: `mgr-${s}@erp.local`, name: `mgr ${s}`, role: 'MANAGER', passwordHash: 'x' },
    });
    userIds.push(staff.id, manager.id);

    async function movement(
      storeId: string,
      type: 'OPENING' | 'ADJUSTMENT' | 'GOODS_RECEIPT' | 'SALE',
      sourceDocument: string,
      qtyChange: number,
      createdAtUtc: string,
    ) {
      await harness.prisma.stockMovement.create({
        data: {
          productId: product.id,
          storeId,
          qtyChange,
          balanceBefore: 0,
          balanceAfter: Math.max(0, qtyChange),
          type,
          sourceDocument,
          reason: type === 'ADJUSTMENT' ? 'manual count' : null,
          actorId: type === 'OPENING' ? null : staff.id,
          createdAt: new Date(createdAtUtc),
        },
      });
    }

    // Store A: a receipt, a manager adjustment and a sale on 2026-01-15 Bangkok; Store B: a receipt.
    await movement(storeA.id, 'GOODS_RECEIPT', 'GR-A-0001', 10, '2026-01-15T03:00:00.000Z');
    await movement(storeA.id, 'ADJUSTMENT', 'ADJUSTMENT', -2, '2026-01-15T05:00:00.000Z');
    await movement(storeA.id, 'SALE', 'SAL-A-0001', -1, '2026-01-15T16:30:00.000Z'); // 23:30 BKK
    await movement(storeB.id, 'GOODS_RECEIPT', 'GR-B-0001', 7, '2026-01-16T02:00:00.000Z');

    const staffPrincipal = {
      id: staff.id,
      email: staff.email,
      name: staff.name,
      role: 'STAFF' as const,
      assignedStoreId: storeA.id,
    };
    const managerPrincipal = {
      id: manager.id,
      email: manager.email,
      name: manager.name,
      role: 'MANAGER' as const,
      assignedStoreId: null,
    };
    return {
      productId: product.id,
      storeAId: storeA.id,
      storeBId: storeB.id,
      staffPrincipal,
      managerPrincipal,
    };
  }

  beforeAll(async () => {
    harness = createIntegrationHarness();
    controller = new ReportsController(harness.prisma as unknown as PrismaService);
  });

  afterAll(async () => {
    if (!harness) return;
    await harness.prisma.stockMovement.deleteMany({ where: { storeId: { in: storeIds } } });
    await harness.prisma.stockBalance.deleteMany({ where: { storeId: { in: storeIds } } });
    await harness.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await harness.prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await harness.prisma.store.deleteMany({ where: { id: { in: storeIds } } });
    await harness.close();
  });

  // Store scope from the principal: a MANAGER sees both stores' movements; a STAFF caller sees only
  // their store even when they ask for the other one — the demo's "staff_b01 sees only B01 while
  // manager01 sees both stores".
  it('shows a MANAGER both stores but a STAFF caller only their assigned store', async () => {
    const { productId, storeAId, storeBId, staffPrincipal, managerPrincipal } =
      await seedMovementScenario();

    const asManager = await call(
      controller.movementHistory(managerPrincipal),
      { page: 1, pageSize: 50, productId },
      { context: {} },
    );
    const managerStores = new Set(asManager.items.map((row) => row.storeId));
    expect(managerStores.has(storeAId)).toBe(true);
    expect(managerStores.has(storeBId)).toBe(true);
    expect(asManager.storeId).toBeNull();

    // The STAFF caller names store B, but is pinned to store A: they see only store A's movements.
    const asStaff = await call(
      controller.movementHistory(staffPrincipal),
      { page: 1, pageSize: 50, productId, storeId: storeBId },
      { context: {} },
    );
    expect(asStaff.storeId).toBe(storeAId);
    expect(asStaff.items.every((row) => row.storeId === storeAId)).toBe(true);
    expect(asStaff.items.some((row) => row.storeId === storeBId)).toBe(false);
  });

  // The report surfaces each movement type with its source-document reference — a receipt, a
  // manager adjustment and a sale, the three the demo opens.
  it('surfaces goods-receipt, adjustment and sale movements with their source documents', async () => {
    const { productId, storeAId, managerPrincipal } = await seedMovementScenario();

    const report = await call(
      controller.movementHistory(managerPrincipal),
      { page: 1, pageSize: 50, productId, storeId: storeAId },
      { context: {} },
    );

    const byType = new Map(report.items.map((row) => [row.type, row.sourceDocument]));
    expect(byType.get('GOODS_RECEIPT')).toBe('GR-A-0001');
    expect(byType.get('ADJUSTMENT')).toBe('ADJUSTMENT');
    expect(byType.get('SALE')).toBe('SAL-A-0001');
    // Newest-first: the 23:30 sale is the most recent movement in store A.
    expect(report.items[0]?.type).toBe('SALE');
  });

  // The half-open Bangkok range keyed on the real timestamp: the 23:30 Bangkok sale lands on the
  // 15th; store B's receipt at 09:00 Bangkok on the 16th does not.
  it('filters on the half-open Bangkok day keyed on the movement timestamp', async () => {
    const { productId, managerPrincipal } = await seedMovementScenario();

    const day15 = await call(
      controller.movementHistory(managerPrincipal),
      { page: 1, pageSize: 50, productId, from: '2026-01-15', to: '2026-01-15' },
      { context: {} },
    );
    // All three store-A movements fall on 2026-01-15 Bangkok; store B's 16th receipt does not.
    const docs15 = day15.items.map((row) => row.sourceDocument);
    expect(docs15).toContain('GR-A-0001');
    expect(docs15).toContain('ADJUSTMENT');
    expect(docs15).toContain('SAL-A-0001');
    expect(docs15).not.toContain('GR-B-0001');

    const day16 = await call(
      controller.movementHistory(managerPrincipal),
      { page: 1, pageSize: 50, productId, from: '2026-01-16', to: '2026-01-16' },
      { context: {} },
    );
    const docs16 = day16.items.map((row) => row.sourceDocument);
    expect(docs16).toContain('GR-B-0001');
    expect(docs16).not.toContain('SAL-A-0001');
  });
});

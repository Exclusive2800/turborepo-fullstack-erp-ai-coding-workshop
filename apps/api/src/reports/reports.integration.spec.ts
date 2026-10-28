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

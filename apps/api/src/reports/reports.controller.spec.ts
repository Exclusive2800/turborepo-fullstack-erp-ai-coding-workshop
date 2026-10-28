import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { reportingDayInterval, UTF8_BOM } from '@erp/contracts';
import { call } from '@orpc/server';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';
import { ReportsController } from './reports.controller.js';

/** Make a Decimal-like money value as Prisma returns it from an aggregate. */
function money(value: number) {
  return { toFixed: (digits: number) => value.toFixed(digits) };
}

interface Stubs {
  /** sale.aggregate result: _count and _sum.total. */
  aggregate?: ReturnType<typeof vi.fn>;
  /** saleLine.aggregate result: _sum.quantity. */
  lineAggregate?: ReturnType<typeof vi.fn>;
  /** stockBalance.findMany result: the on-hand rows. */
  balanceFindMany?: ReturnType<typeof vi.fn>;
  /** productStoreThreshold.findMany result: the per-store thresholds. */
  thresholdFindMany?: ReturnType<typeof vi.fn>;
  /** stockMovement.findMany result: the movement-history page rows. */
  movementFindMany?: ReturnType<typeof vi.fn>;
  /** stockMovement.count result: the movement-history total. */
  movementCount?: ReturnType<typeof vi.fn>;
}

async function createController(stubs: Stubs = {}) {
  const aggregate =
    stubs.aggregate ?? vi.fn().mockResolvedValue({ _count: { _all: 0 }, _sum: { total: null } });
  const lineAggregate =
    stubs.lineAggregate ?? vi.fn().mockResolvedValue({ _sum: { quantity: null } });
  const balanceFindMany = stubs.balanceFindMany ?? vi.fn().mockResolvedValue([]);
  const thresholdFindMany = stubs.thresholdFindMany ?? vi.fn().mockResolvedValue([]);
  const movementFindMany = stubs.movementFindMany ?? vi.fn().mockResolvedValue([]);
  const movementCount = stubs.movementCount ?? vi.fn().mockResolvedValue(0);
  const moduleRef = await Test.createTestingModule({
    controllers: [ReportsController],
    providers: [
      {
        provide: PrismaService,
        useValue: {
          sale: { aggregate },
          saleLine: { aggregate: lineAggregate },
          stockBalance: { findMany: balanceFindMany },
          productStoreThreshold: { findMany: thresholdFindMany },
          stockMovement: { findMany: movementFindMany, count: movementCount },
        },
      },
    ],
  }).compile();
  return {
    controller: moduleRef.get(ReportsController),
    aggregate,
    lineAggregate,
    balanceFindMany,
    thresholdFindMany,
    movementFindMany,
    movementCount,
  };
}

/** A stockBalance row as Prisma returns it with the product/store fields the report joins. */
function balanceRow(
  productId: string,
  storeId: string,
  quantity: number,
  product: { sku: string; name: string; unit: string },
  storeCode: string,
) {
  return { productId, storeId, quantity, product, store: { code: storeCode } };
}

describe('ReportsController', () => {
  describe('dailySales (Seam 1)', () => {
    it('counts only CONFIRMED sales in the half-open Bangkok interval and returns count, units and amount', async () => {
      const aggregate = vi
        .fn()
        .mockResolvedValue({ _count: { _all: 3 }, _sum: { total: money(455) } });
      const lineAggregate = vi.fn().mockResolvedValue({ _sum: { quantity: 9 } });
      const { controller } = await createController({ aggregate, lineAggregate });

      const result = await call(controller.dailySales(), {
        from: '2026-01-15',
        to: '2026-01-15',
        storeId: 'store-b01',
      });

      expect(result).toEqual({
        from: '2026-01-15',
        to: '2026-01-15',
        storeId: 'store-b01',
        documentCount: 3,
        unitsSold: 9,
        amount: '455.00',
      });

      // Only CONFIRMED sales, filtered by the sale's store and the half-open confirmation-timestamp
      // interval the Bangkok helper computes (end exclusive).
      const interval = reportingDayInterval('2026-01-15', '2026-01-15');
      expect(aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: 'CONFIRMED',
            storeId: 'store-b01',
            confirmedAt: { gte: interval.startUtc, lt: interval.endUtc },
          },
          _count: { _all: true },
          _sum: { total: true },
        }),
      );
      // Units are summed over the lines of those same confirmed sales.
      expect(lineAggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            sale: {
              status: 'CONFIRMED',
              storeId: 'store-b01',
              confirmedAt: { gte: interval.startUtc, lt: interval.endUtc },
            },
          },
          _sum: { quantity: true },
        }),
      );
    });

    it('reports across all stores when no storeId is given (no store filter)', async () => {
      const aggregate = vi
        .fn()
        .mockResolvedValue({ _count: { _all: 2 }, _sum: { total: money(120) } });
      const lineAggregate = vi.fn().mockResolvedValue({ _sum: { quantity: 4 } });
      const { controller } = await createController({ aggregate, lineAggregate });

      const result = await call(controller.dailySales(), { from: '2026-01-01', to: '2026-01-31' });

      expect(result.storeId).toBeNull();
      expect(result.documentCount).toBe(2);
      const where = aggregate.mock.calls[0]?.[0]?.where;
      expect(where).not.toHaveProperty('storeId');
      expect(where.status).toBe('CONFIRMED');
    });

    it('returns zero totals and "0.00" when nothing matches (AC-08 sales-zero half)', async () => {
      const { controller } = await createController();

      const result = await call(controller.dailySales(), {
        from: '2026-02-01',
        to: '2026-02-01',
        storeId: 'store-b02',
      });

      expect(result).toEqual({
        from: '2026-02-01',
        to: '2026-02-01',
        storeId: 'store-b02',
        documentCount: 0,
        unitsSold: 0,
        amount: '0.00',
      });
    });
  });

  // Authz: the daily sales report is open to MANAGER (RPT-01, user story 46).
  it('restricts the daily sales report to MANAGER', () => {
    const reflector = new Reflector();
    expect(reflector.get(ROLES_KEY, ReportsController.prototype.dailySales)).toEqual(['MANAGER']);
  });

  describe('stockOnHand (Seam 1)', () => {
    const waterProduct = { sku: 'SKU001', name: 'Water', unit: 'pack' };
    const detergentProduct = { sku: 'SKU003', name: 'Detergent', unit: 'bag' };

    it('returns per-store on-hand rows with threshold and low-stock flag, keeping zero-stock matches visible', async () => {
      const balanceFindMany = vi
        .fn()
        .mockResolvedValue([
          balanceRow('p1', 's1', 10, waterProduct, 'B01'),
          balanceRow('p3', 's1', 0, detergentProduct, 'B01'),
        ]);
      const thresholdFindMany = vi.fn().mockResolvedValue([
        { productId: 'p1', storeId: 's1', threshold: 3 },
        { productId: 'p3', storeId: 's1', threshold: 3 },
      ]);
      const { controller } = await createController({ balanceFindMany, thresholdFindMany });

      const result = await call(controller.stockOnHand(), { storeId: 's1', query: 'SK' });

      expect(result.storeId).toBe('s1');
      expect(result.total).toBe(2);
      // The zero-stock detergent row is present and flagged low-stock (0 <= 3); water is not.
      expect(result.items).toEqual([
        {
          productId: 'p1',
          sku: 'SKU001',
          name: 'Water',
          unit: 'pack',
          storeId: 's1',
          storeCode: 'B01',
          quantity: 10,
          reorderThreshold: 3,
          lowStock: false,
        },
        {
          productId: 'p3',
          sku: 'SKU003',
          name: 'Detergent',
          unit: 'bag',
          storeId: 's1',
          storeCode: 'B01',
          quantity: 0,
          reorderThreshold: 3,
          lowStock: true,
        },
      ]);
    });

    it('scopes the balance query to the store and matches SKU or name case-insensitively', async () => {
      const balanceFindMany = vi.fn().mockResolvedValue([]);
      const { controller } = await createController({ balanceFindMany });

      await call(controller.stockOnHand(), { storeId: 's1', query: 'water' });

      const where = balanceFindMany.mock.calls[0]?.[0]?.where;
      expect(where.storeId).toBe('s1');
      expect(where.product.OR).toEqual([
        { sku: { contains: 'water', mode: 'insensitive' } },
        { name: { contains: 'water', mode: 'insensitive' } },
      ]);
    });

    it('reports across all stores when no storeId is given (no store filter)', async () => {
      const balanceFindMany = vi.fn().mockResolvedValue([]);
      const { controller } = await createController({ balanceFindMany });

      const result = await call(controller.stockOnHand(), {});

      expect(result.storeId).toBeNull();
      const where = balanceFindMany.mock.calls[0]?.[0]?.where;
      expect(where).not.toHaveProperty('storeId');
    });

    it('treats a row with no threshold as not low-stock (null threshold)', async () => {
      const balanceFindMany = vi
        .fn()
        .mockResolvedValue([balanceRow('p1', 's1', 0, waterProduct, 'B01')]);
      const thresholdFindMany = vi.fn().mockResolvedValue([]);
      const { controller } = await createController({ balanceFindMany, thresholdFindMany });

      const result = await call(controller.stockOnHand(), { storeId: 's1' });

      expect(result.items[0]).toMatchObject({ reorderThreshold: null, lowStock: false });
    });

    it('returns an empty list when nothing matches (AC-08 empty state)', async () => {
      const { controller } = await createController();

      const result = await call(controller.stockOnHand(), { storeId: 's2', query: 'ZZZ' });

      expect(result).toEqual({ storeId: 's2', items: [], total: 0 });
    });
  });

  describe('lowStock (Seam 1)', () => {
    const waterProduct = { sku: 'SKU001', name: 'Water', unit: 'pack' };
    const detergentProduct = { sku: 'SKU003', name: 'Detergent', unit: 'bag' };

    it('returns only rows at or below threshold; SKU003 at balance 0, threshold 3 appears (0 ≤ 3)', async () => {
      const balanceFindMany = vi.fn().mockResolvedValue([
        balanceRow('p1', 's1', 10, waterProduct, 'B01'), // above threshold → excluded
        balanceRow('p3', 's1', 0, detergentProduct, 'B01'), // 0 ≤ 3 → included
      ]);
      const thresholdFindMany = vi.fn().mockResolvedValue([
        { productId: 'p1', storeId: 's1', threshold: 3 },
        { productId: 'p3', storeId: 's1', threshold: 3 },
      ]);
      const { controller } = await createController({ balanceFindMany, thresholdFindMany });

      const result = await call(controller.lowStock(), { storeId: 's1' });

      expect(result.storeId).toBe('s1');
      expect(result.total).toBe(1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        sku: 'SKU003',
        quantity: 0,
        reorderThreshold: 3,
        lowStock: true,
      });
    });

    it('includes a product exactly at threshold and excludes one just above', async () => {
      const balanceFindMany = vi.fn().mockResolvedValue([
        balanceRow('p1', 's1', 3, waterProduct, 'B01'), // exactly at threshold → low-stock
        balanceRow('p3', 's1', 4, detergentProduct, 'B01'), // just above → not low-stock
      ]);
      const thresholdFindMany = vi.fn().mockResolvedValue([
        { productId: 'p1', storeId: 's1', threshold: 3 },
        { productId: 'p3', storeId: 's1', threshold: 3 },
      ]);
      const { controller } = await createController({ balanceFindMany, thresholdFindMany });

      const result = await call(controller.lowStock(), { storeId: 's1' });

      expect(result.items.map((i) => i.sku)).toEqual(['SKU001']);
    });

    it('excludes a product with no threshold for the store', async () => {
      const balanceFindMany = vi
        .fn()
        .mockResolvedValue([balanceRow('p1', 's1', 0, waterProduct, 'B01')]);
      const thresholdFindMany = vi.fn().mockResolvedValue([]);
      const { controller } = await createController({ balanceFindMany, thresholdFindMany });

      const result = await call(controller.lowStock(), { storeId: 's1' });

      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('scopes the balance query to the required store', async () => {
      const balanceFindMany = vi.fn().mockResolvedValue([]);
      const { controller } = await createController({ balanceFindMany });

      await call(controller.lowStock(), { storeId: 's1', query: 'SKU' });

      const where = balanceFindMany.mock.calls[0]?.[0]?.where;
      expect(where.storeId).toBe('s1');
    });

    it('returns an empty list when nothing is low-stock (AC-08 empty state)', async () => {
      const balanceFindMany = vi
        .fn()
        .mockResolvedValue([balanceRow('p1', 's1', 10, waterProduct, 'B01')]);
      const thresholdFindMany = vi
        .fn()
        .mockResolvedValue([{ productId: 'p1', storeId: 's1', threshold: 3 }]);
      const { controller } = await createController({ balanceFindMany, thresholdFindMany });

      const result = await call(controller.lowStock(), { storeId: 's1' });

      expect(result).toEqual({ storeId: 's1', items: [], total: 0 });
    });
  });

  // Authz: the stock reports are open to any permitted user (RPT-02, user story 47) — no @Roles.
  it('leaves the stock-on-hand and low-stock reports open to any signed-in user', () => {
    const reflector = new Reflector();
    expect(reflector.get(ROLES_KEY, ReportsController.prototype.stockOnHand)).toBeUndefined();
    expect(reflector.get(ROLES_KEY, ReportsController.prototype.lowStock)).toBeUndefined();
  });

  describe('movementHistory (Seam 1)', () => {
    const manager = {
      id: 'u-mgr',
      email: 'manager01@erp.local',
      name: 'Manager One',
      role: 'MANAGER' as const,
      assignedStoreId: null,
    };
    const staffB01 = {
      id: 'u-staff',
      email: 'staff_b01@erp.local',
      name: 'Staff B01',
      role: 'STAFF' as const,
      assignedStoreId: 'store-b01',
    };

    /** A ledger row joined to its product/store, as Prisma returns it (timestamp as a Date). */
    function movementRow(overrides: Record<string, unknown> = {}) {
      return {
        id: 'm1',
        productId: 'p1',
        storeId: 'store-b01',
        qtyChange: 5,
        balanceBefore: 10,
        balanceAfter: 15,
        type: 'GOODS_RECEIPT' as const,
        sourceDocument: 'GR-000001',
        reason: null,
        actorId: 'u-staff',
        createdAt: new Date('2026-01-15T10:00:00.000Z'),
        product: { sku: 'SKU001', name: 'Water' },
        store: { code: 'B01' },
        ...overrides,
      };
    }

    it('returns newest-first rows with the source document and the store/product display fields', async () => {
      const movementFindMany = vi
        .fn()
        .mockResolvedValue([
          movementRow({ id: 'm2', type: 'SALE', sourceDocument: 'SAL-000002', qtyChange: -2 }),
          movementRow(),
        ]);
      const movementCount = vi.fn().mockResolvedValue(2);
      const { controller } = await createController({ movementFindMany, movementCount });

      const result = await call(
        controller.movementHistory(manager),
        { page: 1, pageSize: 20 },
        { context: {} },
      );

      expect(result.total).toBe(2);
      expect(result.storeId).toBeNull();
      expect(result.items[0]).toMatchObject({
        id: 'm2',
        type: 'SALE',
        sourceDocument: 'SAL-000002',
        sku: 'SKU001',
        productName: 'Water',
        storeCode: 'B01',
        qtyChange: -2,
      });
      // Newest-first ordering on the ledger timestamp.
      expect(movementFindMany.mock.calls[0]?.[0]?.orderBy).toEqual({ createdAt: 'desc' });
      // The timestamp is serialized to a UTC ISO string.
      expect(result.items[1]?.createdAt).toBe('2026-01-15T10:00:00.000Z');
    });

    it('scopes a STAFF caller to their assigned store, ignoring a storeId in the request', async () => {
      const movementFindMany = vi.fn().mockResolvedValue([]);
      const movementCount = vi.fn().mockResolvedValue(0);
      const { controller } = await createController({ movementFindMany, movementCount });

      // The STAFF caller asks for store-b02, but is pinned to store-b01.
      const result = await call(
        controller.movementHistory(staffB01),
        { page: 1, pageSize: 20, storeId: 'store-b02' },
        { context: {} },
      );

      expect(result.storeId).toBe('store-b01');
      const where = movementFindMany.mock.calls[0]?.[0]?.where;
      expect(where.storeId).toBe('store-b01');
    });

    it('lets a MANAGER see every store when no store is named, and one store when named', async () => {
      const movementFindMany = vi.fn().mockResolvedValue([]);
      const { controller } = await createController({ movementFindMany });

      await call(controller.movementHistory(manager), { page: 1, pageSize: 20 }, { context: {} });
      const allWhere = movementFindMany.mock.calls[0]?.[0]?.where;
      expect(allWhere).not.toHaveProperty('storeId');

      await call(
        controller.movementHistory(manager),
        { page: 1, pageSize: 20, storeId: 'store-b02' },
        { context: {} },
      );
      const oneWhere = movementFindMany.mock.calls[1]?.[0]?.where;
      expect(oneWhere.storeId).toBe('store-b02');
    });

    it('treats every cross-store role the same way (ADMIN/PURCHASING see all stores, like MANAGER)', async () => {
      const movementFindMany = vi.fn().mockResolvedValue([]);
      const { controller } = await createController({ movementFindMany });

      // A PURCHASING officer is cross-store (role = what, store = where), so with no store named the
      // report spans every store — the same app-wide store-scope rule the other features use.
      const purchasing = {
        id: 'u-buy',
        email: 'buyer01@erp.local',
        name: 'Buyer One',
        role: 'PURCHASING' as const,
        assignedStoreId: null,
      };
      const result = await call(
        controller.movementHistory(purchasing),
        { page: 1, pageSize: 20 },
        { context: {} },
      );

      expect(result.storeId).toBeNull();
      const where = movementFindMany.mock.calls[0]?.[0]?.where;
      expect(where).not.toHaveProperty('storeId');
    });

    it('filters by product, type and the half-open Bangkok date range', async () => {
      const movementFindMany = vi.fn().mockResolvedValue([]);
      const { controller } = await createController({ movementFindMany });

      await call(
        controller.movementHistory(manager),
        {
          page: 1,
          pageSize: 20,
          productId: 'p1',
          type: 'ADJUSTMENT',
          from: '2026-01-15',
          to: '2026-01-15',
        },
        { context: {} },
      );

      const interval = reportingDayInterval('2026-01-15', '2026-01-15');
      const where = movementFindMany.mock.calls[0]?.[0]?.where;
      expect(where.productId).toBe('p1');
      expect(where.type).toBe('ADJUSTMENT');
      // Keyed on the movement timestamp, end exclusive.
      expect(where.createdAt).toEqual({ gte: interval.startUtc, lt: interval.endUtc });
    });

    it('applies only the supplied bound for an open-ended range', async () => {
      const movementFindMany = vi.fn().mockResolvedValue([]);
      const { controller } = await createController({ movementFindMany });

      await call(
        controller.movementHistory(manager),
        { page: 1, pageSize: 20, from: '2026-01-15' },
        { context: {} },
      );

      const interval = reportingDayInterval('2026-01-15', '2026-01-15');
      const where = movementFindMany.mock.calls[0]?.[0]?.where;
      expect(where.createdAt).toEqual({ gte: interval.startUtc });
    });

    it('returns an empty page when nothing matches (AC empty state)', async () => {
      const { controller } = await createController();

      const result = await call(
        controller.movementHistory(manager),
        { page: 1, pageSize: 20, storeId: 'store-b02' },
        { context: {} },
      );

      expect(result).toEqual({
        storeId: 'store-b02',
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
      });
    });
  });

  // Authz: the movement-history report is open to any permitted user (RPT-03, #19) — no @Roles. The
  // store scope is enforced inside the handler from the principal, not by a role gate.
  it('leaves the movement-history report open to any signed-in user', () => {
    const reflector = new Reflector();
    expect(reflector.get(ROLES_KEY, ReportsController.prototype.movementHistory)).toBeUndefined();
  });

  describe('salesCsv (Seam 1, RPT-04 #20)', () => {
    it('exports the daily sales report as a Thai-safe, formula-injection-safe CSV using the same filters', async () => {
      const aggregate = vi
        .fn()
        .mockResolvedValue({ _count: { _all: 3 }, _sum: { total: money(455) } });
      const lineAggregate = vi.fn().mockResolvedValue({ _sum: { quantity: 9 } });
      const { controller } = await createController({ aggregate, lineAggregate });

      const result = await call(controller.salesCsv(), {
        from: '2026-01-15',
        to: '2026-01-15',
        storeId: 'store-b01',
      });

      // Same CONFIRMED-sale filter as the on-screen report (the export reuses the report query).
      const interval = reportingDayInterval('2026-01-15', '2026-01-15');
      expect(aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: 'CONFIRMED',
            storeId: 'store-b01',
            confirmedAt: { gte: interval.startUtc, lt: interval.endUtc },
          },
        }),
      );

      // A filename naming the range, and a BOM-prefixed CSV carrying the aggregate figures.
      expect(result.filename).toBe('daily-sales-2026-01-15_2026-01-15.csv');
      expect(result.content.startsWith(UTF8_BOM)).toBe(true);
      expect(result.content).toContain('455.00');
      expect(result.content).toContain('9');
      expect(result.content).toContain('3');
    });
  });

  // Authz: the daily-sales CSV export carries the SAME permission as the report it exports (MANAGER).
  it('restricts the daily-sales CSV export to MANAGER, like the report it exports', () => {
    const reflector = new Reflector();
    expect(reflector.get(ROLES_KEY, ReportsController.prototype.salesCsv)).toEqual(['MANAGER']);
  });

  describe('stockOnHandCsv (Seam 1, RPT-04 #20)', () => {
    const detergentProduct = { sku: 'SKU003', name: 'Detergent', unit: 'bag' };

    it('exports the stock-on-hand report as a Thai-safe CSV using the same filters', async () => {
      const balanceFindMany = vi
        .fn()
        .mockResolvedValue([balanceRow('p3', 's1', 0, detergentProduct, 'B01')]);
      const thresholdFindMany = vi
        .fn()
        .mockResolvedValue([{ productId: 'p3', storeId: 's1', threshold: 3 }]);
      const { controller } = await createController({ balanceFindMany, thresholdFindMany });

      const result = await call(controller.stockOnHandCsv(), { storeId: 's1', query: 'SKU003' });

      // Reuses the on-hand query: store scope and SKU-or-name search.
      const where = balanceFindMany.mock.calls[0]?.[0]?.where;
      expect(where.storeId).toBe('s1');
      expect(where.product.OR).toEqual([
        { sku: { contains: 'SKU003', mode: 'insensitive' } },
        { name: { contains: 'SKU003', mode: 'insensitive' } },
      ]);

      expect(result.filename).toBe('stock-on-hand.csv');
      expect(result.content.startsWith(UTF8_BOM)).toBe(true);
      expect(result.content).toContain('SKU003');
      expect(result.content).toContain('Detergent');
    });

    it('neutralizes a product name that a spreadsheet would read as a formula (CWE-1236)', async () => {
      const malicious = { sku: 'SKU666', name: "=cmd|' /C calc'!A0", unit: 'ชิ้น' };
      const balanceFindMany = vi
        .fn()
        .mockResolvedValue([balanceRow('p9', 's1', 5, malicious, 'B01')]);
      const { controller } = await createController({ balanceFindMany });

      const result = await call(controller.stockOnHandCsv(), { storeId: 's1' });

      // The dangerous cell is stored as literal text (leading apostrophe) so no formula executes.
      expect(result.content).toContain("'=cmd|' /C calc'!A0");
      expect(result.content).not.toMatch(/,=cmd/);
    });
  });

  // Authz: the stock-on-hand CSV export is open to any permitted user, like the report it exports.
  it('leaves the stock-on-hand CSV export open to any signed-in user, like the report it exports', () => {
    const reflector = new Reflector();
    expect(reflector.get(ROLES_KEY, ReportsController.prototype.stockOnHandCsv)).toBeUndefined();
  });
});

import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { INSUFFICIENT_STOCK_MESSAGE } from '@erp/contracts';
import { call } from '@orpc/server';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';
import { StockController } from './stock.controller.js';
import { StockPostingService } from './stock-posting.service.js';

// A balance row joined to its product and store, as `search` reads it.
function balanceRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    productId: 'p1',
    storeId: 's1',
    quantity: 10,
    product: { sku: 'SKU001', name: 'Drinking water pack of 6', unit: 'pack' },
    store: { code: 'B01' },
    ...over,
  };
}

async function createController(stock: {
  stockBalance?: Record<string, unknown>;
  stockMovement?: Record<string, unknown>;
  productStoreThreshold?: Record<string, unknown>;
  posting?: Partial<StockPostingService>;
}) {
  const moduleRef = await Test.createTestingModule({
    controllers: [StockController],
    providers: [
      {
        provide: PrismaService,
        useValue: {
          stockBalance: stock.stockBalance ?? {},
          stockMovement: stock.stockMovement ?? {},
          productStoreThreshold: stock.productStoreThreshold ?? {},
        },
      },
      {
        provide: StockPostingService,
        useValue: stock.posting ?? {},
      },
    ],
  }).compile();
  return moduleRef.get(StockController);
}

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
  assignedStoreId: 's1',
};

describe('StockController', () => {
  describe('search', () => {
    it('returns quantity, unit, threshold and a false low-stock flag when above threshold', async () => {
      const findMany = vi.fn().mockResolvedValue([balanceRow({ quantity: 10 })]);
      const count = vi.fn().mockResolvedValue(1);
      const thresholdFindMany = vi
        .fn()
        .mockResolvedValue([{ productId: 'p1', storeId: 's1', threshold: 3 }]);
      const controller = await createController({
        stockBalance: { findMany, count },
        productStoreThreshold: { findMany: thresholdFindMany },
      });

      const result = await call(controller.search(manager), { page: 1, pageSize: 20 });

      expect(result.items[0]).toMatchObject({
        productId: 'p1',
        sku: 'SKU001',
        name: 'Drinking water pack of 6',
        unit: 'pack',
        storeId: 's1',
        storeCode: 'B01',
        quantity: 10,
        reorderThreshold: 3,
        lowStock: false,
      });
      expect(result).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    });

    it('flags low stock when quantity equals the threshold boundary', async () => {
      const findMany = vi.fn().mockResolvedValue([balanceRow({ quantity: 3 })]);
      const thresholdFindMany = vi
        .fn()
        .mockResolvedValue([{ productId: 'p1', storeId: 's1', threshold: 3 }]);
      const controller = await createController({
        stockBalance: { findMany, count: vi.fn().mockResolvedValue(1) },
        productStoreThreshold: { findMany: thresholdFindMany },
      });

      const result = await call(controller.search(manager), { page: 1, pageSize: 20 });

      expect(result.items[0]).toMatchObject({ quantity: 3, lowStock: true });
    });

    it('keeps a zero-stock match visible and flags it low', async () => {
      const findMany = vi.fn().mockResolvedValue([balanceRow({ quantity: 0 })]);
      const thresholdFindMany = vi
        .fn()
        .mockResolvedValue([{ productId: 'p1', storeId: 's1', threshold: 3 }]);
      const controller = await createController({
        stockBalance: { findMany, count: vi.fn().mockResolvedValue(1) },
        productStoreThreshold: { findMany: thresholdFindMany },
      });

      const result = await call(controller.search(manager), { page: 1, pageSize: 20 });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ quantity: 0, lowStock: true });
    });

    it('reports a null threshold and never-low when the store has no threshold set', async () => {
      const findMany = vi.fn().mockResolvedValue([balanceRow({ quantity: 0 })]);
      const thresholdFindMany = vi.fn().mockResolvedValue([]);
      const controller = await createController({
        stockBalance: { findMany, count: vi.fn().mockResolvedValue(1) },
        productStoreThreshold: { findMany: thresholdFindMany },
      });

      const result = await call(controller.search(manager), { page: 1, pageSize: 20 });

      expect(result.items[0]).toMatchObject({ reorderThreshold: null, lowStock: false });
    });

    it('passes the SKU/name query and store filter through to the balance query', async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const count = vi.fn().mockResolvedValue(0);
      const controller = await createController({
        stockBalance: { findMany, count },
        productStoreThreshold: { findMany: vi.fn().mockResolvedValue([]) },
      });

      await call(controller.search(manager), {
        page: 1,
        pageSize: 20,
        query: 'water',
        storeId: 's1',
      });

      const where = findMany.mock.calls[0]?.[0]?.where;
      expect(where).toMatchObject({ storeId: 's1' });
      // The query matches SKU or product name case-insensitively.
      expect(JSON.stringify(where)).toContain('water');
      expect(JSON.stringify(where).toLowerCase()).toContain('insensitive');
    });

    // Store scope (RPT-03, user story 3): a STAFF reader is pinned to their assigned store even
    // when the request names another store, and a cross-store MANAGER reads every store or one.
    it('forces a STAFF caller to their assigned store, ignoring a storeId in the request', async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const controller = await createController({
        stockBalance: { findMany, count: vi.fn().mockResolvedValue(0) },
        productStoreThreshold: { findMany: vi.fn().mockResolvedValue([]) },
      });

      // staff_b01 is assigned to s1 but asks for s2; the handler must scope to s1.
      await call(controller.search(staffB01), { page: 1, pageSize: 20, storeId: 's2' });

      expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({ storeId: 's1' });
    });

    it('rejects an unassigned STAFF caller', async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const controller = await createController({
        stockBalance: { findMany, count: vi.fn().mockResolvedValue(0) },
        productStoreThreshold: { findMany: vi.fn().mockResolvedValue([]) },
      });

      await expect(
        call(controller.search({ ...staffB01, assignedStoreId: null }), {
          page: 1,
          pageSize: 20,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(findMany).not.toHaveBeenCalled();
    });

    it('leaves a MANAGER unscoped when no store is named, and scoped when one is', async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const controller = await createController({
        stockBalance: { findMany, count: vi.fn().mockResolvedValue(0) },
        productStoreThreshold: { findMany: vi.fn().mockResolvedValue([]) },
      });

      await call(controller.search(manager), { page: 1, pageSize: 20 });
      expect(findMany.mock.calls[0]?.[0]?.where).not.toHaveProperty('storeId');

      await call(controller.search(manager), { page: 1, pageSize: 20, storeId: 's2' });
      expect(findMany.mock.calls[1]?.[0]?.where).toMatchObject({ storeId: 's2' });
    });
  });

  describe('movements', () => {
    it('lists ledger movements newest-first with pagination metadata', async () => {
      const findMany = vi.fn().mockResolvedValue([
        {
          id: 'm1',
          productId: 'p1',
          storeId: 's1',
          qtyChange: 10,
          balanceBefore: 0,
          balanceAfter: 10,
          type: 'OPENING',
          sourceDocument: 'OPENING',
          actorId: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ]);
      const count = vi.fn().mockResolvedValue(1);
      const controller = await createController({ stockMovement: { findMany, count } });

      const result = await call(controller.movements(manager), { page: 1, pageSize: 20 });

      expect(result.items[0]).toMatchObject({
        id: 'm1',
        type: 'OPENING',
        balanceAfter: 10,
        actorId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: 'desc' } }),
      );
    });

    it('filters movements by product, store and type', async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const controller = await createController({
        stockMovement: { findMany, count: vi.fn().mockResolvedValue(0) },
      });

      await call(controller.movements(manager), {
        page: 1,
        pageSize: 20,
        productId: 'p1',
        storeId: 's1',
        type: 'SALE',
      });

      expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({
        productId: 'p1',
        storeId: 's1',
        type: 'SALE',
      });
    });

    // Store scope (RPT-03, user story 3): the ledger read is pinned to a STAFF caller's assigned
    // store so they cannot read another store's movements, and a MANAGER reads every store or one.
    it('forces a STAFF caller to their assigned store, ignoring a storeId in the request', async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const controller = await createController({
        stockMovement: { findMany, count: vi.fn().mockResolvedValue(0) },
      });

      // staff_b01 is assigned to s1 but asks for s2; the handler must scope to s1.
      await call(controller.movements(staffB01), { page: 1, pageSize: 20, storeId: 's2' });

      expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({ storeId: 's1' });
    });

    it('rejects an unassigned STAFF caller', async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const controller = await createController({
        stockMovement: { findMany, count: vi.fn().mockResolvedValue(0) },
      });

      await expect(
        call(controller.movements({ ...staffB01, assignedStoreId: null }), {
          page: 1,
          pageSize: 20,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(findMany).not.toHaveBeenCalled();
    });

    it('leaves a MANAGER unscoped when no store is named, and scoped when one is', async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const controller = await createController({
        stockMovement: { findMany, count: vi.fn().mockResolvedValue(0) },
      });

      await call(controller.movements(manager), { page: 1, pageSize: 20 });
      expect(findMany.mock.calls[0]?.[0]?.where).not.toHaveProperty('storeId');

      await call(controller.movements(manager), { page: 1, pageSize: 20, storeId: 's2' });
      expect(findMany.mock.calls[1]?.[0]?.where).toMatchObject({ storeId: 's2' });
    });
  });

  // The ledger is append-only: the controller exposes no edit or delete route for a movement.
  it('exposes no handler that edits or deletes a confirmed movement', () => {
    const names = Object.getOwnPropertyNames(StockController.prototype);
    expect(names).not.toContain('update');
    expect(names).not.toContain('delete');
    expect(names.filter((n) => n !== 'constructor').sort()).toEqual([
      'adjust',
      'movements',
      'search',
    ]);
  });

  describe('adjust', () => {
    it('lets a manager post an increase and returns the recorded movement', async () => {
      const post = vi.fn().mockResolvedValue({ id: 'm9', balanceBefore: 10, balanceAfter: 15 });
      const row = {
        id: 'm9',
        productId: 'p1',
        storeId: 's1',
        qtyChange: 5,
        balanceBefore: 10,
        balanceAfter: 15,
        type: 'ADJUSTMENT',
        sourceDocument: 'ADJUSTMENT',
        reason: 'นับสต็อกใหม่',
        actorId: 'u-mgr',
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
      };
      const findUnique = vi.fn().mockResolvedValue(row);
      const controller = await createController({
        stockMovement: { findUnique },
        posting: { post } as Partial<StockPostingService>,
      });

      const result = await call(controller.adjust(manager), {
        productId: 'p1',
        storeId: 's1',
        qtyChange: 5,
        reason: 'นับสต็อกใหม่',
      });

      // The reason, actor and type are recorded on the posted movement (INV-05, INV-02).
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({
          productId: 'p1',
          storeId: 's1',
          qtyChange: 5,
          type: 'ADJUSTMENT',
          reason: 'นับสต็อกใหม่',
          actorId: 'u-mgr',
        }),
      );
      expect(result).toMatchObject({
        id: 'm9',
        type: 'ADJUSTMENT',
        qtyChange: 5,
        reason: 'นับสต็อกใหม่',
        actorId: 'u-mgr',
        createdAt: '2026-01-02T00:00:00.000Z',
      });
    });

    it('posts a decrease as a negative movement', async () => {
      const post = vi.fn().mockResolvedValue({ id: 'm10', balanceBefore: 10, balanceAfter: 7 });
      const findUnique = vi.fn().mockResolvedValue({
        id: 'm10',
        productId: 'p1',
        storeId: 's1',
        qtyChange: -3,
        balanceBefore: 10,
        balanceAfter: 7,
        type: 'ADJUSTMENT',
        sourceDocument: 'ADJUSTMENT',
        reason: 'ของเสียหาย',
        actorId: 'u-mgr',
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
      });
      const controller = await createController({
        stockMovement: { findUnique },
        posting: { post } as Partial<StockPostingService>,
      });

      await call(controller.adjust(manager), {
        productId: 'p1',
        storeId: 's1',
        qtyChange: -3,
        reason: 'ของเสียหาย',
      });

      expect(post).toHaveBeenCalledWith(expect.objectContaining({ qtyChange: -3 }));
    });

    it('propagates the never-negative rejection from the posting service', async () => {
      const post = vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error(INSUFFICIENT_STOCK_MESSAGE), { code: 'CONFLICT' }),
        );
      const controller = await createController({
        posting: { post } as Partial<StockPostingService>,
      });

      await expect(
        call(controller.adjust(manager), {
          productId: 'p1',
          storeId: 's1',
          qtyChange: -99,
          reason: 'ปรับลด',
        }),
      ).rejects.toMatchObject({ message: INSUFFICIENT_STOCK_MESSAGE });
    });
  });

  // Authz: stock reads are open to any signed-in user (store employees check availability).
  it('leaves stock reads open to any authenticated user', () => {
    const reflector = new Reflector();
    expect(reflector.get(ROLES_KEY, StockController.prototype.search)).toBeUndefined();
    expect(reflector.get(ROLES_KEY, StockController.prototype.movements)).toBeUndefined();
  });

  // Authz: only a MANAGER may adjust stock (INV-05); a non-manager is rejected by the guard.
  it('restricts the adjustment handler to MANAGER', () => {
    const reflector = new Reflector();
    expect(reflector.get(ROLES_KEY, StockController.prototype.adjust)).toEqual(['MANAGER']);
  });
});

import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { call } from '@orpc/server';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';
import { StockController } from './stock.controller.js';

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
    ],
  }).compile();
  return moduleRef.get(StockController);
}

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

      const result = await call(controller.search(), { page: 1, pageSize: 20 });

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

      const result = await call(controller.search(), { page: 1, pageSize: 20 });

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

      const result = await call(controller.search(), { page: 1, pageSize: 20 });

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

      const result = await call(controller.search(), { page: 1, pageSize: 20 });

      expect(result.items[0]).toMatchObject({ reorderThreshold: null, lowStock: false });
    });

    it('passes the SKU/name query and store filter through to the balance query', async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const count = vi.fn().mockResolvedValue(0);
      const controller = await createController({
        stockBalance: { findMany, count },
        productStoreThreshold: { findMany: vi.fn().mockResolvedValue([]) },
      });

      await call(controller.search(), { page: 1, pageSize: 20, query: 'water', storeId: 's1' });

      const where = findMany.mock.calls[0]?.[0]?.where;
      expect(where).toMatchObject({ storeId: 's1' });
      // The query matches SKU or product name case-insensitively.
      expect(JSON.stringify(where)).toContain('water');
      expect(JSON.stringify(where).toLowerCase()).toContain('insensitive');
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

      const result = await call(controller.movements(), { page: 1, pageSize: 20 });

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

      await call(controller.movements(), {
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
  });

  // The ledger is append-only: the controller exposes no edit or delete route for a movement.
  it('exposes no handler that edits or deletes a confirmed movement', () => {
    const names = Object.getOwnPropertyNames(StockController.prototype);
    expect(names).not.toContain('update');
    expect(names).not.toContain('delete');
    expect(names.filter((n) => n !== 'constructor').sort()).toEqual(['movements', 'search']);
  });

  // Authz: stock reads are open to any signed-in user (store employees check availability).
  it('leaves stock reads open to any authenticated user', () => {
    const reflector = new Reflector();
    expect(reflector.get(ROLES_KEY, StockController.prototype.search)).toBeUndefined();
    expect(reflector.get(ROLES_KEY, StockController.prototype.movements)).toBeUndefined();
  });
});

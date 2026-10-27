import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  duplicateCodeMessage,
  NOT_FOUND_MESSAGE,
  PRODUCT_INACTIVE_MESSAGE,
  SKU_LOCKED_MESSAGE,
} from '@erp/contracts';
import { call } from '@orpc/server';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';
import { ProductsController } from './products.controller.js';

const row = {
  id: 'p1',
  sku: 'SKU001',
  name: 'Drinking water pack of 6',
  category: 'Beverages',
  unit: 'pack',
  sellingPrice: { toFixed: () => '60.00' } as unknown as { toFixed: (n: number) => string },
  active: true,
  skuLocked: false,
  thresholds: [{ storeId: 's1', threshold: 3 }],
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

async function createController(product: Record<string, unknown>) {
  const moduleRef = await Test.createTestingModule({
    controllers: [ProductsController],
    providers: [{ provide: PrismaService, useValue: { product } }],
  }).compile();
  return moduleRef.get(ProductsController);
}

const createInput = {
  sku: 'SKU001',
  name: 'Drinking water pack of 6',
  category: 'Beverages',
  unit: 'pack',
  sellingPrice: 60,
  active: true,
  thresholds: [{ storeId: 's1', threshold: 3 }],
};

describe('ProductsController', () => {
  it('lists products newest first (including deactivated) with pagination metadata', async () => {
    const findMany = vi.fn().mockResolvedValue([row]);
    const count = vi.fn().mockResolvedValue(1);
    const controller = await createController({ findMany, count });

    const result = await call(controller.list(), { page: 1, pageSize: 20 });

    expect(result.items[0]).toMatchObject({
      id: 'p1',
      sku: 'SKU001',
      sellingPrice: '60.00',
      active: true,
      thresholds: [{ storeId: 's1', threshold: 3 }],
    });
    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' }, skip: 0, take: 20 }),
    );
    // No `where` filter — deactivated products stay in the list for historical search.
    expect(findMany.mock.calls[0][0]).not.toHaveProperty('where');
  });

  it('creates a product with its per-store thresholds', async () => {
    const create = vi.fn().mockResolvedValue(row);
    const controller = await createController({ create });

    await expect(call(controller.create(), createInput)).resolves.toMatchObject({
      sku: 'SKU001',
      sellingPrice: '60.00',
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sku: 'SKU001',
          sellingPrice: 60,
          active: true,
          thresholds: { create: [{ storeId: 's1', threshold: 3 }] },
        }),
      }),
    );
  });

  it('rejects a duplicate SKU with an actionable Thai message', async () => {
    const create = vi.fn().mockRejectedValue({ code: 'P2002', meta: { target: ['sku'] } });
    const controller = await createController({ create });

    await expect(call(controller.create(), createInput)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: duplicateCodeMessage('SKU001'),
    });
  });

  it('updates a product and replaces its thresholds', async () => {
    const findUnique = vi.fn().mockResolvedValue({ sku: 'SKU001', skuLocked: false });
    const update = vi.fn().mockResolvedValue({ ...row, name: 'Water 6-pack' });
    const controller = await createController({ findUnique, update });

    await expect(
      call(controller.update(), { ...createInput, id: 'p1', name: 'Water 6-pack' }),
    ).resolves.toMatchObject({ name: 'Water 6-pack' });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p1' },
        data: expect.objectContaining({
          name: 'Water 6-pack',
          thresholds: { deleteMany: {}, create: [{ storeId: 's1', threshold: 3 }] },
        }),
      }),
    );
  });

  it('rejects changing the SKU once the product is locked by a transaction', async () => {
    const findUnique = vi.fn().mockResolvedValue({ sku: 'SKU001', skuLocked: true });
    const update = vi.fn();
    const controller = await createController({ findUnique, update });

    await expect(
      call(controller.update(), { ...createInput, id: 'p1', sku: 'SKU999' }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: SKU_LOCKED_MESSAGE });
    expect(update).not.toHaveBeenCalled();
  });

  it('allows keeping the same SKU on a locked product', async () => {
    const findUnique = vi.fn().mockResolvedValue({ sku: 'SKU001', skuLocked: true });
    const update = vi.fn().mockResolvedValue(row);
    const controller = await createController({ findUnique, update });

    await expect(
      call(controller.update(), { ...createInput, id: 'p1', name: 'Renamed' }),
    ).resolves.toMatchObject({ sku: 'SKU001' });
    expect(update).toHaveBeenCalled();
  });

  it('rejects updating a product that does not exist', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const controller = await createController({ findUnique, update: vi.fn() });

    await expect(
      call(controller.update(), { ...createInput, id: 'missing' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE });
  });

  it('returns an active product as eligible for a new document', async () => {
    const findUnique = vi.fn().mockResolvedValue(row);
    const controller = await createController({ findUnique });

    await expect(call(controller.checkForDocument(), { id: 'p1' })).resolves.toMatchObject({
      id: 'p1',
      active: true,
    });
  });

  it('rejects a deactivated product for a new document but it stays searchable in the list', async () => {
    const findUnique = vi.fn().mockResolvedValue({ ...row, active: false });
    const controller = await createController({ findUnique });

    await expect(call(controller.checkForDocument(), { id: 'p1' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: PRODUCT_INACTIVE_MESSAGE,
    });
  });

  it('returns NOT_FOUND when checking a product that does not exist', async () => {
    const findUnique = vi.fn().mockResolvedValue(null);
    const controller = await createController({ findUnique });

    await expect(call(controller.checkForDocument(), { id: 'missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: NOT_FOUND_MESSAGE,
    });
  });

  // Authz: writes are ADMIN-only; reads (list, checkForDocument) stay open to any signed-in user.
  it('restricts create and update to ADMIN and leaves reads open', () => {
    const reflector = new Reflector();
    expect(reflector.get(ROLES_KEY, ProductsController.prototype.create)).toEqual(['ADMIN']);
    expect(reflector.get(ROLES_KEY, ProductsController.prototype.update)).toEqual(['ADMIN']);
    expect(reflector.get(ROLES_KEY, ProductsController.prototype.list)).toBeUndefined();
    expect(
      reflector.get(ROLES_KEY, ProductsController.prototype.checkForDocument),
    ).toBeUndefined();
  });
});

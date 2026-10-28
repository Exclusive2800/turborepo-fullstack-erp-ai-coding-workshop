import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { NOT_FOUND_MESSAGE, PRODUCT_INACTIVE_MESSAGE, type Whoami } from '@erp/contracts';
import { call } from '@orpc/server';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';
import { SalesController } from './sales.controller.js';

const staffB01: Whoami = {
  id: 'u-staff-b01',
  email: 'staff_b01@erp.local',
  name: 'Staff B01',
  role: 'STAFF',
  assignedStoreId: 'store-b01',
};

const staffUnassigned: Whoami = { ...staffB01, id: 'u-floating', assignedStoreId: null };

/** Make a Decimal-like money value as Prisma returns it. */
function money(value: number) {
  return { toFixed: (digits: number) => value.toFixed(digits) };
}

/** A stored sale line row as Prisma hands it back. */
function lineRow(over: Record<string, unknown> = {}) {
  return {
    id: 'l1',
    productId: 'p1',
    sku: 'SKU001',
    productName: 'Drinking water pack of 6',
    quantity: 2,
    unitPrice: money(60),
    lineTotal: money(120),
    ...over,
  };
}

function saleRow(over: Record<string, unknown> = {}) {
  return {
    id: 'sale1',
    storeId: 'store-b01',
    status: 'DRAFT',
    total: money(120),
    lines: [lineRow()],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  };
}

interface Stubs {
  product?: Record<string, unknown>;
  sale?: Record<string, unknown>;
  saleCreate?: ReturnType<typeof vi.fn>;
}

async function createController(stubs: Stubs = {}) {
  const saleCreate = stubs.saleCreate ?? vi.fn().mockResolvedValue(saleRow());
  // A spy that must never be called: a draft sale opens no transaction and posts no stock.
  const $transaction = vi.fn();
  const moduleRef = await Test.createTestingModule({
    controllers: [SalesController],
    providers: [
      {
        provide: PrismaService,
        useValue: {
          product: stubs.product ?? {},
          sale: { create: saleCreate, ...(stubs.sale ?? {}) },
          $transaction,
        },
      },
    ],
  }).compile();
  return { controller: moduleRef.get(SalesController), saleCreate, $transaction };
}

const createInput = { lines: [{ productId: 'p1', quantity: 2 }] };

describe('SalesController', () => {
  describe('create', () => {
    it('creates a DRAFT sale for the staff user’s assigned store, derived from the principal', async () => {
      const findMany = vi.fn().mockResolvedValue([
        { id: 'p1', sku: 'SKU001', name: 'Drinking water pack of 6', active: true, sellingPrice: money(60) },
      ]);
      const { controller, saleCreate } = await createController({ product: { findMany } });

      const result = await call(controller.create(staffB01), createInput);

      expect(result).toMatchObject({ status: 'DRAFT', storeId: 'store-b01' });
      // The store comes from the principal (staff is pinned to store-b01), and the creator is recorded.
      expect(saleCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'DRAFT',
            storeId: 'store-b01',
            createdById: 'u-staff-b01',
          }),
        }),
      );
    });

    it('snapshots the current selling price onto each line and ignores any client price override', async () => {
      const findMany = vi.fn().mockResolvedValue([
        { id: 'p1', sku: 'SKU001', name: 'Drinking water pack of 6', active: true, sellingPrice: money(60) },
        { id: 'p2', sku: 'SKU002', name: 'Tissue paper', active: true, sellingPrice: money(35) },
      ]);
      const { controller, saleCreate } = await createController({ product: { findMany } });

      await call(controller.create(staffB01), {
        // A client sneaks a unitPrice onto the line; it must be ignored (the contract strips it, and
        // the handler reads the product's current sellingPrice regardless).
        lines: [
          { productId: 'p1', quantity: 2, unitPrice: 1 },
          { productId: 'p2', quantity: 3, unitPrice: 0 },
        ],
      } as never);

      const data = saleCreate.mock.calls[0]?.[0]?.data;
      expect(data.lines.create).toEqual([
        expect.objectContaining({
          productId: 'p1',
          sku: 'SKU001',
          productName: 'Drinking water pack of 6',
          quantity: 2,
          unitPrice: '60.00',
          lineTotal: '120.00',
        }),
        expect.objectContaining({
          productId: 'p2',
          sku: 'SKU002',
          productName: 'Tissue paper',
          quantity: 3,
          unitPrice: '35.00',
          lineTotal: '105.00',
        }),
      ]);
      // total = 2×60 + 3×35 = 120 + 105 = 225
      expect(data.total).toBe('225.00');
    });

    it('writes no stock movement and opens no transaction for a draft sale (SAL-03)', async () => {
      const findMany = vi.fn().mockResolvedValue([
        { id: 'p1', sku: 'SKU001', name: 'Drinking water pack of 6', active: true, sellingPrice: money(60) },
      ]);
      const { controller, $transaction } = await createController({ product: { findMany } });

      await call(controller.create(staffB01), createInput);

      // A draft sale reserves no stock: it never posts to the ledger and never opens the
      // post-and-stock transaction. Only confirmation (#14) moves inventory.
      expect($transaction).not.toHaveBeenCalled();
    });

    it('rejects a deactivated product with the actionable Thai message', async () => {
      const findMany = vi
        .fn()
        .mockResolvedValue([{ id: 'p1', sku: 'SKU001', name: 'Old water', active: false, sellingPrice: money(60) }]);
      const { controller, saleCreate } = await createController({ product: { findMany } });

      await expect(call(controller.create(staffB01), createInput)).rejects.toMatchObject({
        code: 'CONFLICT',
        message: PRODUCT_INACTIVE_MESSAGE,
      });
      expect(saleCreate).not.toHaveBeenCalled();
    });

    it('rejects a sale whose line references a missing product', async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const { controller } = await createController({ product: { findMany } });

      await expect(call(controller.create(staffB01), createInput)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: NOT_FOUND_MESSAGE,
      });
    });

    it('rejects a staff user who is not assigned to any store (cannot derive a store)', async () => {
      const findMany = vi.fn().mockResolvedValue([
        { id: 'p1', sku: 'SKU001', name: 'Drinking water pack of 6', active: true, sellingPrice: money(60) },
      ]);
      const { controller, saleCreate } = await createController({ product: { findMany } });

      await expect(call(controller.create(staffUnassigned), createInput)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(saleCreate).not.toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('returns a sale with its lines', async () => {
      const findUnique = vi.fn().mockResolvedValue(saleRow());
      const { controller } = await createController({ sale: { findUnique } });

      const result = await call(controller.get(), { id: 'sale1' });

      expect(result).toMatchObject({ id: 'sale1', status: 'DRAFT', storeId: 'store-b01' });
      expect(result.lines[0]).toMatchObject({ sku: 'SKU001', unitPrice: '60.00', lineTotal: '120.00' });
    });

    it('returns NOT_FOUND for a missing sale', async () => {
      const findUnique = vi.fn().mockResolvedValue(null);
      const { controller } = await createController({ sale: { findUnique } });

      await expect(call(controller.get(), { id: 'missing' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: NOT_FOUND_MESSAGE,
      });
    });
  });

  describe('list', () => {
    it('lists sales newest-first with pagination metadata', async () => {
      const findMany = vi.fn().mockResolvedValue([saleRow()]);
      const count = vi.fn().mockResolvedValue(1);
      const { controller } = await createController({ sale: { findMany, count } });

      const result = await call(controller.list(), { page: 1, pageSize: 20 });

      expect(result).toMatchObject({ total: 1, page: 1, pageSize: 20 });
      expect(result.items[0]).toMatchObject({ id: 'sale1' });
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: 'desc' } }),
      );
    });
  });

  // Authz: only STAFF may create a sale; reads stay open to any signed-in user.
  it('restricts create to STAFF and leaves reads open', () => {
    const reflector = new Reflector();
    expect(reflector.get(ROLES_KEY, SalesController.prototype.create)).toEqual(['STAFF']);
    expect(reflector.get(ROLES_KEY, SalesController.prototype.list)).toBeUndefined();
    expect(reflector.get(ROLES_KEY, SalesController.prototype.get)).toBeUndefined();
  });
});

import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { NOT_FOUND_MESSAGE, PRODUCT_INACTIVE_MESSAGE } from '@erp/contracts';
import { call } from '@orpc/server';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';
import { StockPostingService } from '../stock/stock-posting.service.js';
import { PurchaseOrdersController } from './purchase-orders.controller.js';

const buyer = {
  id: 'u-buyer',
  email: 'buyer01@erp.local',
  name: 'Buyer One',
  role: 'PURCHASING' as const,
  assignedStoreId: null,
};

/** Make a Decimal-like money value as Prisma returns it. */
function money(value: number) {
  return { toFixed: (digits: number) => value.toFixed(digits) };
}

/** A stored line row as Prisma hands it back (echoing what `create` was given). */
function lineRow(over: Record<string, unknown> = {}) {
  return {
    id: 'l1',
    productId: 'p1',
    sku: 'SKU001',
    productName: 'Drinking water pack of 6',
    quantity: 20,
    unitPrice: money(45),
    lineTotal: money(900),
    ...over,
  };
}

function orderRow(over: Record<string, unknown> = {}) {
  return {
    id: 'po1',
    number: 'PO-000001',
    status: 'DRAFT',
    supplierId: 'sup1',
    storeId: 's1',
    expectedReceiptDate: new Date('2026-02-01T00:00:00.000Z'),
    total: money(900),
    lines: [lineRow()],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...over,
  };
}

interface Stubs {
  product?: Record<string, unknown>;
  purchaseOrder?: Record<string, unknown>;
  transactionCreate?: ReturnType<typeof vi.fn>;
  posting?: Partial<StockPostingService>;
}

async function createController(stubs: Stubs = {}) {
  // $transaction(cb) runs the callback with a tx client exposing the PO create used inside it.
  const txCreate = stubs.transactionCreate ?? vi.fn().mockResolvedValue(orderRow());
  const $transaction = vi.fn(async (cb: (tx: unknown) => unknown) =>
    cb({ purchaseOrder: { create: txCreate } }),
  );
  const moduleRef = await Test.createTestingModule({
    controllers: [PurchaseOrdersController],
    providers: [
      {
        provide: PrismaService,
        useValue: {
          product: stubs.product ?? {},
          purchaseOrder: stubs.purchaseOrder ?? {},
          $transaction,
        },
      },
      {
        provide: StockPostingService,
        useValue: stubs.posting ?? {
          allocateDocumentNumber: vi.fn().mockResolvedValue('PO-000001'),
          post: vi.fn(),
        },
      },
    ],
  }).compile();
  return { controller: moduleRef.get(PurchaseOrdersController), $transaction, txCreate };
}

const createInput = {
  supplierId: 'sup1',
  storeId: 's1',
  expectedReceiptDate: '2026-02-01T00:00:00.000Z',
  lines: [{ productId: 'p1', quantity: 20, unitPrice: 45 }],
};

describe('PurchaseOrdersController', () => {
  describe('create', () => {
    it('creates a DRAFT order for a purchasing user with an allocated PO number', async () => {
      const findMany = vi
        .fn()
        .mockResolvedValue([{ id: 'p1', sku: 'SKU001', name: 'Drinking water pack of 6', active: true }]);
      const allocateDocumentNumber = vi.fn().mockResolvedValue('PO-000001');
      const post = vi.fn();
      const { controller, txCreate } = await createController({
        product: { findMany },
        posting: { allocateDocumentNumber, post } as Partial<StockPostingService>,
      });

      const result = await call(controller.create(buyer), createInput);

      expect(result).toMatchObject({
        number: 'PO-000001',
        status: 'DRAFT',
        supplierId: 'sup1',
        storeId: 's1',
      });
      expect(allocateDocumentNumber).toHaveBeenCalledWith('PO', expect.anything());
      // The order is persisted at DRAFT with the creator recorded.
      expect(txCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'DRAFT', number: 'PO-000001', createdById: 'u-buyer' }),
        }),
      );
    });

    it('snapshots each line product name and price and computes lineTotal and order total', async () => {
      const findMany = vi.fn().mockResolvedValue([
        { id: 'p1', sku: 'SKU001', name: 'Drinking water pack of 6', active: true },
        { id: 'p2', sku: 'SKU002', name: 'Tissue paper', active: true },
      ]);
      const { controller, txCreate } = await createController({ product: { findMany } });

      await call(controller.create(buyer), {
        ...createInput,
        lines: [
          { productId: 'p1', quantity: 20, unitPrice: 45 },
          { productId: 'p2', quantity: 5, unitPrice: 35 },
        ],
      });

      const data = txCreate.mock.calls[0]?.[0]?.data;
      expect(data.lines.create).toEqual([
        expect.objectContaining({
          productId: 'p1',
          sku: 'SKU001',
          productName: 'Drinking water pack of 6',
          quantity: 20,
          unitPrice: '45.00',
          lineTotal: '900.00',
        }),
        expect.objectContaining({
          productId: 'p2',
          sku: 'SKU002',
          productName: 'Tissue paper',
          quantity: 5,
          unitPrice: '35.00',
          lineTotal: '175.00',
        }),
      ]);
      // total = 20×45 + 5×35 = 900 + 175 = 1075
      expect(data.total).toBe('1075.00');
    });

    it('writes no stock movement when creating an order (PO-02)', async () => {
      const findMany = vi
        .fn()
        .mockResolvedValue([{ id: 'p1', sku: 'SKU001', name: 'Drinking water pack of 6', active: true }]);
      const post = vi.fn();
      const { controller } = await createController({
        product: { findMany },
        posting: {
          allocateDocumentNumber: vi.fn().mockResolvedValue('PO-000001'),
          post,
        } as Partial<StockPostingService>,
      });

      await call(controller.create(buyer), createInput);

      // Creating an order never posts to the ledger; only receiving (#9) moves inventory.
      expect(post).not.toHaveBeenCalled();
    });

    it('rejects a deactivated product with the actionable Thai message', async () => {
      const findMany = vi
        .fn()
        .mockResolvedValue([{ id: 'p1', sku: 'SKU001', name: 'Old water', active: false }]);
      const { controller, txCreate } = await createController({ product: { findMany } });

      await expect(call(controller.create(buyer), createInput)).rejects.toMatchObject({
        code: 'CONFLICT',
        message: PRODUCT_INACTIVE_MESSAGE,
      });
      expect(txCreate).not.toHaveBeenCalled();
    });

    it('rejects an order whose line references a missing product', async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const { controller } = await createController({ product: { findMany } });

      await expect(call(controller.create(buyer), createInput)).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: NOT_FOUND_MESSAGE,
      });
    });
  });

  describe('get', () => {
    it('returns an order with its lines', async () => {
      const findUnique = vi.fn().mockResolvedValue(orderRow());
      const { controller } = await createController({ purchaseOrder: { findUnique } });

      const result = await call(controller.get(), { id: 'po1' });

      expect(result).toMatchObject({ id: 'po1', number: 'PO-000001', status: 'DRAFT' });
      expect(result.lines[0]).toMatchObject({ sku: 'SKU001', unitPrice: '45.00', lineTotal: '900.00' });
    });

    it('returns NOT_FOUND for a missing order', async () => {
      const findUnique = vi.fn().mockResolvedValue(null);
      const { controller } = await createController({ purchaseOrder: { findUnique } });

      await expect(call(controller.get(), { id: 'missing' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: NOT_FOUND_MESSAGE,
      });
    });
  });

  describe('list', () => {
    it('lists orders newest-first with pagination metadata', async () => {
      const findMany = vi.fn().mockResolvedValue([orderRow()]);
      const count = vi.fn().mockResolvedValue(1);
      const { controller } = await createController({ purchaseOrder: { findMany, count } });

      const result = await call(controller.list(), { page: 1, pageSize: 20 });

      expect(result).toMatchObject({ total: 1, page: 1, pageSize: 20 });
      expect(result.items[0]).toMatchObject({ number: 'PO-000001' });
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: 'desc' } }),
      );
    });
  });

  // Authz: only PURCHASING may create; reads stay open to any signed-in user.
  it('restricts create to PURCHASING and leaves reads open', () => {
    const reflector = new Reflector();
    expect(reflector.get(ROLES_KEY, PurchaseOrdersController.prototype.create)).toEqual([
      'PURCHASING',
    ]);
    expect(reflector.get(ROLES_KEY, PurchaseOrdersController.prototype.list)).toBeUndefined();
    expect(reflector.get(ROLES_KEY, PurchaseOrdersController.prototype.get)).toBeUndefined();
  });
});

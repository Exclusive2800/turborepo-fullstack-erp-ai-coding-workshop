import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  contract,
  GR_LINE_NOT_ON_ORDER_MESSAGE,
  GR_ORDER_NOT_RECEIVABLE_MESSAGE,
  GR_OVER_RECEIVE_MESSAGE,
  NOT_FOUND_MESSAGE,
  STORE_SCOPE_FORBIDDEN_MESSAGE,
} from '@erp/contracts';
import { call } from '@orpc/server';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';
import { StockPostingService } from '../stock/stock-posting.service.js';
import { GoodsReceiptsController } from './goods-receipts.controller.js';

const staffB01 = {
  id: 'u-staff',
  email: 'staff_b01@erp.local',
  name: 'Staff B01',
  role: 'STAFF' as const,
  assignedStoreId: 's1',
};

const staffB02 = {
  id: 'u-staff2',
  email: 'staff_b02@erp.local',
  name: 'Staff B02',
  role: 'STAFF' as const,
  assignedStoreId: 's2',
};

/** A PO line row as Prisma returns it, with its cumulative received rolled up for the view. */
function poLineRow(over: Record<string, unknown> = {}) {
  return {
    id: 'pol1',
    productId: 'p1',
    sku: 'SKU001',
    productName: 'Drinking water pack of 6',
    quantity: 20,
    goodsReceiptLines: [] as { quantity: number }[],
    ...over,
  };
}

/** A stored PO row with lines and rolled-up received quantities, as the receive handler loads it. */
function orderRow(over: Record<string, unknown> = {}) {
  return {
    id: 'po1',
    number: 'PO-DEMO-001',
    status: 'APPROVED',
    storeId: 's1',
    lines: [poLineRow()],
    ...over,
  };
}

/** A stored goods receipt as Prisma returns it (timestamp as a Date). */
function receiptRow(over: Record<string, unknown> = {}) {
  return {
    id: 'gr1',
    number: 'GR-000001',
    purchaseOrderId: 'po1',
    storeId: 's1',
    receivedById: 'u-staff',
    lines: [
      {
        id: 'grl1',
        purchaseOrderLineId: 'pol1',
        productId: 'p1',
        sku: 'SKU001',
        productName: 'Drinking water pack of 6',
        quantity: 8,
      },
    ],
    createdAt: new Date('2026-02-01T00:00:00.000Z'),
    ...over,
  };
}

interface Stubs {
  purchaseOrder?: Record<string, unknown>;
  goodsReceipt?: Record<string, unknown>;
  posting?: Partial<StockPostingService>;
  /** The tx client fields the transaction callback uses. */
  tx?: Record<string, unknown>;
}

async function createController(stubs: Stubs = {}) {
  // Every receive transaction now locks the PO lines (`$queryRaw ... FOR UPDATE`) and re-sums the
  // committed received quantity (`goodsReceiptLine.groupBy`) before writing. Provide those on the
  // transaction client by default — groupBy returns no prior receipts unless a test says otherwise,
  // so the authoritative in-transaction check matches the request-time snapshot the test set up.
  const txClient = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    goodsReceiptLine: { groupBy: vi.fn().mockResolvedValue([]) },
    ...stubs.tx,
  };
  const $transaction = vi.fn(async (cb: (tx: unknown) => unknown) => cb(txClient));
  const moduleRef = await Test.createTestingModule({
    controllers: [GoodsReceiptsController],
    providers: [
      {
        provide: PrismaService,
        useValue: {
          purchaseOrder: stubs.purchaseOrder ?? {},
          goodsReceipt: stubs.goodsReceipt ?? {},
          $transaction,
        },
      },
      {
        provide: StockPostingService,
        useValue: stubs.posting ?? {
          allocateDocumentNumber: vi.fn().mockResolvedValue('GR-000001'),
          post: vi.fn().mockResolvedValue({ id: 'm1', balanceBefore: 10, balanceAfter: 18 }),
        },
      },
    ],
  }).compile();
  return { controller: moduleRef.get(GoodsReceiptsController), $transaction, txClient };
}

const receiveInput = {
  purchaseOrderId: 'po1',
  lines: [{ purchaseOrderLineId: 'pol1', quantity: 8 }],
};

describe('GoodsReceiptsController', () => {
  describe('receivable (Seam 3 data)', () => {
    it('returns ordered, received and outstanding per line', async () => {
      const findUnique = vi.fn().mockResolvedValue(
        orderRow({
          lines: [poLineRow({ quantity: 20, goodsReceiptLines: [{ quantity: 5 }] })],
        }),
      );
      const { controller } = await createController({ purchaseOrder: { findUnique } });

      const result = await call(controller.receivable(staffB01), { purchaseOrderId: 'po1' });

      expect(result).toMatchObject({ id: 'po1', number: 'PO-DEMO-001', status: 'APPROVED' });
      expect(result.lines[0]).toMatchObject({
        purchaseOrderLineId: 'pol1',
        ordered: 20,
        received: 5,
        outstanding: 15,
      });
    });

    it('returns NOT_FOUND for a missing order', async () => {
      const findUnique = vi.fn().mockResolvedValue(null);
      const { controller } = await createController({ purchaseOrder: { findUnique } });

      await expect(
        call(controller.receivable(staffB01), { purchaseOrderId: 'missing' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE });
    });

    it('forbids a STAFF user from viewing an order for another store', async () => {
      const findUnique = vi.fn().mockResolvedValue(orderRow({ storeId: 's1' }));
      const { controller } = await createController({ purchaseOrder: { findUnique } });

      await expect(
        call(controller.receivable(staffB02), { purchaseOrderId: 'po1' }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', message: STORE_SCOPE_FORBIDDEN_MESSAGE });
    });
  });

  describe('receive (Seam 1 + Seam 2)', () => {
    it('allocates a receipt number, posts one movement per line and advances to PARTIALLY_RECEIVED', async () => {
      const findUnique = vi.fn().mockResolvedValue(orderRow());
      const allocateDocumentNumber = vi.fn().mockResolvedValue('GR-000001');
      const post = vi.fn().mockResolvedValue({ id: 'm1', balanceBefore: 10, balanceAfter: 18 });
      const grCreate = vi.fn().mockResolvedValue({ id: 'gr1' });
      const poUpdate = vi.fn().mockResolvedValue({});
      const grFindUnique = vi.fn().mockResolvedValue(receiptRow());
      const { controller, txClient } = await createController({
        purchaseOrder: { findUnique },
        goodsReceipt: { findUnique: grFindUnique },
        posting: { allocateDocumentNumber, post } as Partial<StockPostingService>,
        tx: {
          goodsReceipt: { create: grCreate },
          purchaseOrder: { update: poUpdate },
        },
      });

      const result = await call(controller.receive(staffB01), receiveInput);

      expect(result).toMatchObject({ number: 'GR-000001', purchaseOrderId: 'po1', storeId: 's1' });
      expect(allocateDocumentNumber).toHaveBeenCalledWith('GR', expect.anything());
      // One stock movement per received line, into the PO's store, type GOODS_RECEIPT.
      expect(post).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({
          productId: 'p1',
          storeId: 's1',
          qtyChange: 8,
          type: 'GOODS_RECEIPT',
          sourceDocument: 'GR-000001',
          actorId: 'u-staff',
        }),
        txClient,
      );
      // 8 of 20 received → still outstanding → PARTIALLY_RECEIVED.
      expect(poUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'po1' },
          data: { status: 'PARTIALLY_RECEIVED' },
        }),
      );
      void txClient;
    });

    it('advances to COMPLETED when the receipt fulfils every outstanding line', async () => {
      const findUnique = vi
        .fn()
        .mockResolvedValue(
          orderRow({ lines: [poLineRow({ quantity: 20, goodsReceiptLines: [{ quantity: 12 }] })] }),
        );
      const poUpdate = vi.fn().mockResolvedValue({});
      const grFindUnique = vi.fn().mockResolvedValue(receiptRow());
      const { controller } = await createController({
        purchaseOrder: { findUnique },
        goodsReceipt: { findUnique: grFindUnique },
        tx: {
          // The authoritative in-transaction read sees 12 already received on this line.
          goodsReceiptLine: {
            groupBy: vi
              .fn()
              .mockResolvedValue([{ purchaseOrderLineId: 'pol1', _sum: { quantity: 12 } }]),
          },
          goodsReceipt: { create: vi.fn().mockResolvedValue({ id: 'gr1' }) },
          purchaseOrder: { update: poUpdate },
        },
      });

      // 12 already received + 8 now = 20 = ordered → COMPLETED.
      await call(controller.receive(staffB01), receiveInput);

      expect(poUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'COMPLETED' } }),
      );
    });

    it('receives against a PARTIALLY_RECEIVED order', async () => {
      const findUnique = vi.fn().mockResolvedValue(
        orderRow({
          status: 'PARTIALLY_RECEIVED',
          lines: [poLineRow({ quantity: 20, goodsReceiptLines: [{ quantity: 5 }] })],
        }),
      );
      const poUpdate = vi.fn().mockResolvedValue({});
      const grFindUnique = vi.fn().mockResolvedValue(receiptRow());
      const { controller } = await createController({
        purchaseOrder: { findUnique },
        goodsReceipt: { findUnique: grFindUnique },
        tx: {
          goodsReceipt: { create: vi.fn().mockResolvedValue({ id: 'gr1' }) },
          purchaseOrder: { update: poUpdate },
        },
      });

      const result = await call(controller.receive(staffB01), receiveInput);
      expect(result.number).toBe('GR-000001');
      expect(poUpdate).toHaveBeenCalled();
    });

    it('rejects receiving against an order that is not Approved or Partially Received', async () => {
      const findUnique = vi.fn().mockResolvedValue(orderRow({ status: 'DRAFT' }));
      const post = vi.fn();
      const grCreate = vi.fn();
      const { controller } = await createController({
        purchaseOrder: { findUnique },
        posting: {
          allocateDocumentNumber: vi.fn(),
          post,
        } as Partial<StockPostingService>,
        tx: { goodsReceipt: { create: grCreate }, purchaseOrder: { update: vi.fn() } },
      });

      await expect(call(controller.receive(staffB01), receiveInput)).rejects.toMatchObject({
        code: 'CONFLICT',
        message: GR_ORDER_NOT_RECEIVABLE_MESSAGE,
      });
      expect(post).not.toHaveBeenCalled();
      expect(grCreate).not.toHaveBeenCalled();
    });

    it('rejects a line that is not on the order', async () => {
      const findUnique = vi.fn().mockResolvedValue(orderRow());
      const post = vi.fn();
      const { controller } = await createController({
        purchaseOrder: { findUnique },
        posting: {
          allocateDocumentNumber: vi.fn(),
          post,
        } as Partial<StockPostingService>,
      });

      await expect(
        call(controller.receive(staffB01), {
          purchaseOrderId: 'po1',
          lines: [{ purchaseOrderLineId: 'not-a-line', quantity: 1 }],
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: GR_LINE_NOT_ON_ORDER_MESSAGE });
      expect(post).not.toHaveBeenCalled();
    });

    it('rejects a receipt that would push cumulative received beyond ordered', async () => {
      const findUnique = vi
        .fn()
        .mockResolvedValue(
          orderRow({ lines: [poLineRow({ quantity: 20, goodsReceiptLines: [{ quantity: 15 }] })] }),
        );
      const post = vi.fn();
      const { controller } = await createController({
        purchaseOrder: { findUnique },
        posting: {
          allocateDocumentNumber: vi.fn(),
          post,
        } as Partial<StockPostingService>,
      });

      // 15 already received, ordered 20, outstanding 5; receiving 8 exceeds it.
      await expect(call(controller.receive(staffB01), receiveInput)).rejects.toMatchObject({
        code: 'CONFLICT',
        message: GR_OVER_RECEIVE_MESSAGE,
      });
      expect(post).not.toHaveBeenCalled();
    });

    it('forbids a STAFF user from receiving an order for another store', async () => {
      const findUnique = vi.fn().mockResolvedValue(orderRow({ storeId: 's1' }));
      const post = vi.fn();
      const { controller } = await createController({
        purchaseOrder: { findUnique },
        posting: {
          allocateDocumentNumber: vi.fn(),
          post,
        } as Partial<StockPostingService>,
      });

      await expect(call(controller.receive(staffB02), receiveInput)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: STORE_SCOPE_FORBIDDEN_MESSAGE,
      });
      expect(post).not.toHaveBeenCalled();
    });

    // AC-04 / GR-01 (#10): the destination store is the PO's store, derived from the authenticated
    // principal, never from the request body. staff_b02 (assigned B02) receiving against
    // PO-DEMO-001, whose destination is B01 ('s1'), is rejected with the standard store-scope authz
    // shape and no write — the receipt number is never allocated, no movement is posted and the
    // transaction never opens. This is the negative-authz slice the demo walks over the API.
    it('rejects staff_b02 receiving against a PO destined for B01 and writes nothing (AC-04)', async () => {
      const findUnique = vi.fn().mockResolvedValue(orderRow({ storeId: 's1' }));
      const allocateDocumentNumber = vi.fn();
      const post = vi.fn();
      const grCreate = vi.fn();
      const poUpdate = vi.fn();
      const { controller, $transaction } = await createController({
        purchaseOrder: { findUnique },
        posting: { allocateDocumentNumber, post } as Partial<StockPostingService>,
        tx: {
          goodsReceipt: { create: grCreate },
          purchaseOrder: { update: poUpdate },
        },
      });

      await expect(call(controller.receive(staffB02), receiveInput)).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: STORE_SCOPE_FORBIDDEN_MESSAGE,
      });
      // The handler bails on the store-scope check before any write path runs.
      expect(allocateDocumentNumber).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(grCreate).not.toHaveBeenCalled();
      expect(poUpdate).not.toHaveBeenCalled();
      expect($transaction).not.toHaveBeenCalled();
    });

    it('returns NOT_FOUND when the order does not exist', async () => {
      const findUnique = vi.fn().mockResolvedValue(null);
      const { controller } = await createController({ purchaseOrder: { findUnique } });

      await expect(
        call(controller.receive(staffB01), { ...receiveInput, purchaseOrderId: 'missing' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', message: NOT_FOUND_MESSAGE });
    });
  });

  // Idempotency (#11, GR-04). A client-supplied key that already has a receipt replays that receipt
  // without touching stock; the lookup happens before the transaction so no number is allocated and
  // no movement is posted. A fresh key falls through to a genuine new receipt. The DB unique
  // constraint (proved over real Postgres in the integration spec) is the source of truth for the
  // concurrent case; this seam proves the request-level replay path.
  describe('receive idempotency (Seam 1, GR-04)', () => {
    it('replays the original receipt for a key that already exists, writing nothing', async () => {
      const orderFindUnique = vi.fn().mockResolvedValue(orderRow());
      const existing = receiptRow({ idempotencyKey: 'key-abc' });
      const grFindFirst = vi.fn().mockResolvedValue(existing);
      const grFindUnique = vi.fn().mockResolvedValue(existing);
      const allocateDocumentNumber = vi.fn();
      const post = vi.fn();
      const grCreate = vi.fn();
      const poUpdate = vi.fn();
      const { controller, $transaction } = await createController({
        purchaseOrder: { findUnique: orderFindUnique },
        goodsReceipt: { findFirst: grFindFirst, findUnique: grFindUnique },
        posting: { allocateDocumentNumber, post } as Partial<StockPostingService>,
        tx: { goodsReceipt: { create: grCreate }, purchaseOrder: { update: poUpdate } },
      });

      const result = await call(controller.receive(staffB01), {
        ...receiveInput,
        idempotencyKey: 'key-abc',
      });

      // The original receipt comes back and no write path ran.
      expect(result).toMatchObject({ number: 'GR-000001' });
      expect(grFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ idempotencyKey: 'key-abc' }),
        }),
      );
      expect($transaction).not.toHaveBeenCalled();
      expect(allocateDocumentNumber).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
      expect(grCreate).not.toHaveBeenCalled();
      expect(poUpdate).not.toHaveBeenCalled();
    });

    it('creates a genuine receipt for a fresh key and persists the key', async () => {
      const orderFindUnique = vi.fn().mockResolvedValue(orderRow());
      // No prior receipt for this key.
      const grFindFirst = vi.fn().mockResolvedValue(null);
      const grFindUnique = vi.fn().mockResolvedValue(receiptRow({ idempotencyKey: 'key-new' }));
      const grCreate = vi.fn().mockResolvedValue({ id: 'gr1' });
      const poUpdate = vi.fn().mockResolvedValue({});
      const { controller } = await createController({
        purchaseOrder: { findUnique: orderFindUnique },
        goodsReceipt: { findFirst: grFindFirst, findUnique: grFindUnique },
        tx: { goodsReceipt: { create: grCreate }, purchaseOrder: { update: poUpdate } },
      });

      const result = await call(controller.receive(staffB01), {
        ...receiveInput,
        idempotencyKey: 'key-new',
      });

      expect(result).toMatchObject({ number: 'GR-000001' });
      // The key is written onto the new receipt so a later retry can find it.
      expect(grCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ idempotencyKey: 'key-new' }),
        }),
      );
    });
  });

  // Immutability (#11, Seam 1, AC-05). A confirmed receipt is append-only: the goods-receipt
  // contract offers no route to edit or cancel one, so there is no handler to reach. If a future
  // change adds a mutation route it must fail this guard deliberately, not by accident.
  describe('receive immutability (Seam 1)', () => {
    it('exposes no edit or cancel route on the goods-receipt contract', () => {
      const routes = Object.keys(contract.goodsReceipt);
      expect(routes.sort()).toEqual(['list', 'receivable', 'receive']);
      // The controller exposes exactly these handlers — nothing that mutates a stored receipt.
      const prototype = GoodsReceiptsController.prototype as unknown as Record<string, unknown>;
      expect(typeof prototype.receive).toBe('function');
      expect(prototype.update).toBeUndefined();
      expect(prototype.cancel).toBeUndefined();
    });
  });

  describe('list', () => {
    it('lists receipts newest-first with pagination metadata', async () => {
      const findMany = vi.fn().mockResolvedValue([receiptRow()]);
      const count = vi.fn().mockResolvedValue(1);
      const { controller } = await createController({ goodsReceipt: { findMany, count } });

      const result = await call(controller.list(), { page: 1, pageSize: 20 });

      expect(result).toMatchObject({ total: 1, page: 1, pageSize: 20 });
      expect(result.items[0]).toMatchObject({ number: 'GR-000001' });
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { createdAt: 'desc' } }),
      );
    });
  });

  // Authz: only STAFF may receive; reads stay open to any signed-in user.
  it('restricts receive to STAFF and leaves reads open', () => {
    const reflector = new Reflector();
    expect(reflector.get(ROLES_KEY, GoodsReceiptsController.prototype.receive)).toEqual(['STAFF']);
    expect(reflector.get(ROLES_KEY, GoodsReceiptsController.prototype.list)).toBeUndefined();
    expect(reflector.get(ROLES_KEY, GoodsReceiptsController.prototype.receivable)).toBeUndefined();
  });
});

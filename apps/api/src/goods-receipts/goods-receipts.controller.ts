import { Controller } from '@nestjs/common';
import {
  contract,
  GR_LINE_NOT_ON_ORDER_MESSAGE,
  GR_ORDER_NOT_RECEIVABLE_MESSAGE,
  GR_OVER_RECEIVE_MESSAGE,
  type GoodsReceipt,
  type GoodsReceiptLine,
  NOT_FOUND_MESSAGE,
  type PurchaseOrderStatus,
  type ReceivableLine,
  type ReceivablePurchaseOrder,
  type Whoami,
} from '@erp/contracts';
import { Implement, implement, ORPCError } from '@orpc/nest';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { assertStoreScope } from '../auth/store-scope.js';
import { PrismaService } from '../database/prisma.service.js';
import { StockPostingService, type StockTxClient } from '../stock/stock-posting.service.js';

/** A PO line row with its receipt lines rolled up, as the receive/receivable handlers load it. */
interface PurchaseOrderLineRow {
  id: string;
  productId: string;
  sku: string;
  productName: string;
  quantity: number;
  goodsReceiptLines: { quantity: number }[];
}

/** A stored PO row with its lines (and their receipts) as Prisma returns it. */
interface PurchaseOrderRow {
  id: string;
  number: string;
  status: PurchaseOrderStatus;
  storeId: string;
  lines: PurchaseOrderLineRow[];
}

/** A stored goods-receipt line row as Prisma returns it. */
interface GoodsReceiptLineRow {
  id: string;
  purchaseOrderLineId: string;
  productId: string;
  sku: string;
  productName: string;
  quantity: number;
}

/** A stored goods receipt with its lines as Prisma returns it (timestamp as a Date). */
interface GoodsReceiptRow {
  id: string;
  number: string;
  purchaseOrderId: string;
  storeId: string;
  receivedById: string;
  lines: GoodsReceiptLineRow[];
  createdAt: Date;
}

/** The include that rolls each PO line's cumulative received quantity up for the math below. */
const RECEIVABLE_INCLUDE = {
  lines: { include: { goodsReceiptLines: { select: { quantity: true } } } },
} as const;

function serializeReceiptLine(row: GoodsReceiptLineRow): GoodsReceiptLine {
  return {
    id: row.id,
    purchaseOrderLineId: row.purchaseOrderLineId,
    productId: row.productId,
    sku: row.sku,
    productName: row.productName,
    quantity: row.quantity,
  };
}

function serializeReceipt(row: GoodsReceiptRow): GoodsReceipt {
  return {
    id: row.id,
    number: row.number,
    purchaseOrderId: row.purchaseOrderId,
    storeId: row.storeId,
    receivedById: row.receivedById,
    lines: row.lines.map(serializeReceiptLine),
    createdAt: row.createdAt.toISOString(),
  };
}

/** The quantity received so far across all prior receipts for a PO line. */
function receivedSoFar(line: PurchaseOrderLineRow): number {
  return line.goodsReceiptLines.reduce((sum, grl) => sum + grl.quantity, 0);
}

function serializeReceivableLine(line: PurchaseOrderLineRow): ReceivableLine {
  const received = receivedSoFar(line);
  return {
    purchaseOrderLineId: line.id,
    productId: line.productId,
    sku: line.sku,
    productName: line.productName,
    ordered: line.quantity,
    received,
    outstanding: Math.max(line.quantity - received, 0),
  };
}

@Controller()
export class GoodsReceiptsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: StockPostingService,
  ) {}

  @Implement(contract.goodsReceipt.list)
  list() {
    return implement(contract.goodsReceipt.list).handler(async ({ input }) => {
      const { page, pageSize, purchaseOrderId } = input;
      const where = purchaseOrderId ? { purchaseOrderId } : {};
      const [rows, total] = await Promise.all([
        this.prisma.goodsReceipt.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: { lines: true },
        }) as Promise<GoodsReceiptRow[]>,
        this.prisma.goodsReceipt.count({ where }),
      ]);
      return { items: rows.map(serializeReceipt), total, page, pageSize };
    });
  }

  /**
   * The receiving view for one purchase order (Seam 3, GR-01): the per-line ordered, previously
   * received and outstanding quantities a store employee needs to record a receipt. A STAFF user may
   * only view an order destined for their assigned store (store scope derived from the principal).
   */
  @Implement(contract.goodsReceipt.receivable)
  receivable(@CurrentUser() user: Whoami) {
    return implement(contract.goodsReceipt.receivable).handler(async ({ input }) => {
      const order = await this.loadOrder(input.purchaseOrderId);
      assertStoreScope(user, order.storeId);
      return this.serializeReceivable(order);
    });
  }

  /**
   * Receive against an approved purchase order (GR-01/GR-02/GR-03, AC-01). Only a STAFF user reaches
   * this handler (`@Roles('STAFF')`), and they may only receive for their assigned store — the
   * destination is the order's store, checked against the principal, never taken from the body.
   *
   * The handler first validates everything that must not produce a partial write (Seam 1): the order
   * must be Approved or Partially Received; every received line must belong to the order; and the
   * cumulative received across all receipts must not exceed the ordered quantity on any line
   * (GR-02). Then, in one transaction (Seam 2, GR-03): it allocates the unique "GR" document number,
   * writes the receipt and its lines, raises the destination store's `StockBalance` and appends one
   * GOODS_RECEIPT `StockMovement` per received line through the shared posting service, and advances
   * the order to PARTIALLY_RECEIVED (quantity still outstanding) or COMPLETED (all lines fully
   * received). Either the whole receipt commits or nothing does.
   */
  @Roles('STAFF')
  @Implement(contract.goodsReceipt.receive)
  receive(@CurrentUser() user: Whoami) {
    return implement(contract.goodsReceipt.receive).handler(async ({ input }) => {
      const order = await this.loadOrder(input.purchaseOrderId);
      assertStoreScope(user, order.storeId);

      if (order.status !== 'APPROVED' && order.status !== 'PARTIALLY_RECEIVED') {
        throw new ORPCError('CONFLICT', { message: GR_ORDER_NOT_RECEIVABLE_MESSAGE });
      }

      const lineById = new Map(order.lines.map((line) => [line.id, line]));

      // Validate every input line against the order before writing anything (GR-02). A line not on
      // the order is a bad request; a line whose cumulative received would exceed ordered is a
      // conflict. Collect the resolved work so the transaction below only writes.
      const work = input.lines.map((inputLine) => {
        const line = lineById.get(inputLine.purchaseOrderLineId);
        if (!line) {
          throw new ORPCError('BAD_REQUEST', { message: GR_LINE_NOT_ON_ORDER_MESSAGE });
        }
        const outstanding = Math.max(line.quantity - receivedSoFar(line), 0);
        if (inputLine.quantity > outstanding) {
          throw new ORPCError('CONFLICT', { message: GR_OVER_RECEIVE_MESSAGE });
        }
        return { line, quantity: inputLine.quantity };
      });

      // Whether this receipt fully satisfies the order: every line's cumulative received (including
      // what is being received now) equals the ordered quantity. Drives the status advance below.
      const receivedNowByLineId = new Map(work.map((w) => [w.line.id, w.quantity]));
      const fullyReceived = order.lines.every((line) => {
        const now = receivedNowByLineId.get(line.id) ?? 0;
        return receivedSoFar(line) + now >= line.quantity;
      });
      const nextStatus: PurchaseOrderStatus = fullyReceived ? 'COMPLETED' : 'PARTIALLY_RECEIVED';

      const receiptId = await this.prisma.$transaction(async (tx) => {
        const txClient = tx as unknown as StockTxClient;
        const number = await this.posting.allocateDocumentNumber('GR', txClient);

        const receipt = await (tx as typeof this.prisma).goodsReceipt.create({
          data: {
            number,
            purchaseOrderId: order.id,
            storeId: order.storeId,
            receivedById: user.id,
            lines: {
              create: work.map(({ line, quantity }) => ({
                purchaseOrderLineId: line.id,
                productId: line.productId,
                sku: line.sku,
                productName: line.productName,
                quantity,
              })),
            },
          },
        });

        // One GOODS_RECEIPT movement per received line, into the order's store, inside this same
        // transaction so the receipt and the stock change commit or roll back together (GR-03).
        for (const { line, quantity } of work) {
          await this.posting.post(
            {
              productId: line.productId,
              storeId: order.storeId,
              qtyChange: quantity,
              type: 'GOODS_RECEIPT',
              sourceDocument: number,
              actorId: user.id,
            },
            txClient,
          );
        }

        await (tx as typeof this.prisma).purchaseOrder.update({
          where: { id: order.id },
          data: { status: nextStatus },
        });

        return receipt.id;
      });

      const row = (await this.prisma.goodsReceipt.findUnique({
        where: { id: receiptId },
        include: { lines: true },
      })) as GoodsReceiptRow | null;
      if (!row) {
        throw new ORPCError('NOT_FOUND', { message: NOT_FOUND_MESSAGE });
      }
      return serializeReceipt(row);
    });
  }

  /** Load an order with its lines and their rolled-up receipts, or throw NOT_FOUND. */
  private async loadOrder(id: string): Promise<PurchaseOrderRow> {
    const order = (await this.prisma.purchaseOrder.findUnique({
      where: { id },
      include: RECEIVABLE_INCLUDE,
    })) as PurchaseOrderRow | null;
    if (!order) {
      throw new ORPCError('NOT_FOUND', { message: NOT_FOUND_MESSAGE });
    }
    return order;
  }

  private serializeReceivable(order: PurchaseOrderRow): ReceivablePurchaseOrder {
    return {
      id: order.id,
      number: order.number,
      status: order.status,
      storeId: order.storeId,
      lines: order.lines.map(serializeReceivableLine),
    };
  }
}

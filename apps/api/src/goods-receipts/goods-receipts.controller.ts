import { Controller } from '@nestjs/common';
import { Prisma } from '@erp/database';
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
import { isUniqueConstraintError } from '../database/prisma-errors.js';
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
   * Idempotency (GR-04): the request may carry a client-supplied `idempotencyKey`. If a receipt with
   * that key already exists, the original receipt is returned and nothing is written — a double
   * click or a retried request after a flaky network never raises stock twice. The key is
   * UNIQUE-constrained in the database, so even two requests racing in parallel resolve to one
   * receipt: the loser's insert hits the unique constraint (P2002) and is turned back into a replay
   * of the winner's receipt. The unique constraint, not this in-memory lookup, is the source of
   * truth; the pre-check only spares the common (non-racing) retry the work of opening a transaction.
   *
   * Over-receive and concurrency (GR-05, AC-03): cumulative received across all receipts can never
   * exceed the ordered quantity on any line. The pre-transaction check below is a fast, friendly
   * rejection against the snapshot read at request time, but it is NOT authoritative under
   * concurrency — two requests can each read a stale "0 received" and both pass it. The binding
   * check runs inside the transaction (`validateAgainstLockedLines`): it locks the order's lines so
   * concurrent receipts serialize, re-sums committed received under the lock, and rejects any line
   * that would exceed ordered. That is what makes "two concurrent receipts never push cumulative
   * past ordered" hold — exactly one wins.
   *
   * On success, in one transaction (Seam 2, GR-03): it allocates the unique "GR" document number,
   * writes the receipt and its lines (carrying the idempotency key), raises the destination store's
   * `StockBalance` and appends one GOODS_RECEIPT `StockMovement` per received line through the shared
   * posting service, and advances the order to PARTIALLY_RECEIVED (quantity still outstanding) or
   * COMPLETED (all lines fully received). Either the whole receipt commits or nothing does.
   */
  @Roles('STAFF')
  @Implement(contract.goodsReceipt.receive)
  receive(@CurrentUser() user: Whoami) {
    return implement(contract.goodsReceipt.receive).handler(async ({ input }) => {
      const order = await this.loadOrder(input.purchaseOrderId);
      assertStoreScope(user, order.storeId);

      // Idempotency replay (GR-04): a key that already has a receipt returns that receipt untouched,
      // before any number is allocated or movement posted. Scoped to this order so a key is only
      // ever reused for the same order.
      if (input.idempotencyKey) {
        const replay = await this.findReceiptByKey(order.id, input.idempotencyKey);
        if (replay) return replay;
      }

      if (order.status !== 'APPROVED' && order.status !== 'PARTIALLY_RECEIVED') {
        throw new ORPCError('CONFLICT', { message: GR_ORDER_NOT_RECEIVABLE_MESSAGE });
      }

      const lineById = new Map(order.lines.map((line) => [line.id, line]));

      // Fast, non-authoritative pre-check against the request-time snapshot (GR-02): a line not on
      // the order is a bad request; a line already over its outstanding is a conflict. This spares
      // the obvious bad request a transaction. The binding over-receive check is inside the
      // transaction below, under a row lock, so concurrent receipts cannot both pass it.
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

      let receiptId: string;
      try {
        receiptId = await this.prisma.$transaction(async (tx) => {
          const txClient = tx as unknown as StockTxClient;

          // Authoritative over-receive + concurrency guard (GR-05, AC-03): lock the order's lines so
          // concurrent receipts for this order serialize, then re-validate every received quantity
          // against the committed cumulative received read under the lock. Returns the next PO
          // status computed from those authoritative numbers.
          const nextStatus = await this.validateAgainstLockedLines(tx, order, work);

          const number = await this.posting.allocateDocumentNumber('GR', txClient);

          const receipt = await (tx as typeof this.prisma).goodsReceipt.create({
            data: {
              number,
              purchaseOrderId: order.id,
              storeId: order.storeId,
              receivedById: user.id,
              idempotencyKey: input.idempotencyKey ?? null,
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
      } catch (error) {
        // Concurrency (GR-04): a second request carrying the same key committed first, so this
        // insert lost the race on the unique constraint. Replay the winner's receipt — the whole
        // transaction (number, movements, status advance) rolled back, so no stock was raised twice.
        if (input.idempotencyKey && isUniqueConstraintError(error)) {
          const replay = await this.findReceiptByKey(order.id, input.idempotencyKey);
          if (replay) return replay;
        }
        throw error;
      }

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

  /**
   * The authoritative over-receive and concurrency guard (GR-05), run inside the receive
   * transaction. It locks the order's purchase-order lines with `SELECT ... FOR UPDATE`, so two
   * receipts against the same order serialize here: the second caller blocks until the first
   * commits, then reads the first's receipt lines. It then re-sums the committed received quantity
   * per line directly from the database (not the request-time snapshot) and rejects the whole
   * receipt if any line would exceed its ordered quantity. Returns the PO status to advance to —
   * COMPLETED when every line is fully received, otherwise PARTIALLY_RECEIVED.
   */
  private async validateAgainstLockedLines(
    tx: unknown,
    order: PurchaseOrderRow,
    work: { line: PurchaseOrderLineRow; quantity: number }[],
  ): Promise<PurchaseOrderStatus> {
    const client = tx as typeof this.prisma;
    const lineIds = order.lines.map((line) => line.id);

    // Lock every line of the order. Concurrent receipts for the same order contend on these rows
    // and take turns, so the cumulative read below is authoritative, never a stale snapshot.
    await client.$queryRaw`
      SELECT "id" FROM "PurchaseOrderLine" WHERE "id" IN (${Prisma.join(lineIds)}) FOR UPDATE
    `;

    // Authoritative cumulative received per line, summed from committed receipt lines under the lock.
    const grouped = await client.goodsReceiptLine.groupBy({
      by: ['purchaseOrderLineId'],
      where: { purchaseOrderLineId: { in: lineIds } },
      _sum: { quantity: true },
    });
    const receivedByLineId = new Map(
      grouped.map((g) => [g.purchaseOrderLineId, g._sum.quantity ?? 0]),
    );
    const receivingNowByLineId = new Map(work.map((w) => [w.line.id, w.quantity]));

    for (const { line, quantity } of work) {
      const already = receivedByLineId.get(line.id) ?? 0;
      if (already + quantity > line.quantity) {
        throw new ORPCError('CONFLICT', { message: GR_OVER_RECEIVE_MESSAGE });
      }
    }

    // COMPLETED only when every line's authoritative received (including what this receipt adds)
    // reaches the ordered quantity; otherwise the order is still outstanding.
    const fullyReceived = order.lines.every((line) => {
      const already = receivedByLineId.get(line.id) ?? 0;
      const now = receivingNowByLineId.get(line.id) ?? 0;
      return already + now >= line.quantity;
    });
    return fullyReceived ? 'COMPLETED' : 'PARTIALLY_RECEIVED';
  }

  /**
   * Look up a stored receipt by its PO and idempotency key (GR-04), or null if there is none yet.
   * Used both for the pre-transaction replay fast path and to resolve a concurrent P2002 loser back
   * to the winner's receipt. Returns the fully serialized receipt so a replay is byte-for-byte the
   * original response.
   */
  private async findReceiptByKey(
    purchaseOrderId: string,
    idempotencyKey: string,
  ): Promise<GoodsReceipt | null> {
    const row = (await this.prisma.goodsReceipt.findFirst({
      where: { purchaseOrderId, idempotencyKey },
      include: { lines: true },
    })) as GoodsReceiptRow | null;
    return row ? serializeReceipt(row) : null;
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

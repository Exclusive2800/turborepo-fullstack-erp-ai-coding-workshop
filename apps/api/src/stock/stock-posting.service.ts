import { Injectable } from '@nestjs/common';
import { INSUFFICIENT_STOCK_MESSAGE, type StockMovementType } from '@erp/contracts';
import { ORPCError } from '@orpc/nest';
import { PrismaService } from '../database/prisma.service.js';

/**
 * The minimal Prisma surface the posting helpers use. Satisfied by both `PrismaService` and the
 * transaction client Prisma hands to `$transaction(async (tx) => ...)`, so a caller can post inside
 * a wider transaction (document + movement commit together, GR-05/SAL-03) or let the service open
 * its own.
 */
export interface StockTxClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  stockBalance: {
    findUnique(args: unknown): Promise<{ id: string; quantity: number } | null>;
    update(args: unknown): Promise<{ quantity: number }>;
    create(args: unknown): Promise<{ id: string; quantity: number }>;
  };
  stockMovement: {
    create(args: unknown): Promise<{ id: string; balanceAfter: number }>;
  };
  product: {
    update(args: unknown): Promise<unknown>;
  };
  documentCounter: {
    upsert(args: unknown): Promise<{ nextValue: number }>;
  };
  issuedDocumentNumber: {
    create(args: unknown): Promise<{ number: string }>;
  };
}

/** A single stock change to post to the ledger (INV-02). `qtyChange` is signed. */
export interface PostMovementInput {
  productId: string;
  storeId: string;
  /** Signed quantity: positive increases stock (receipt), negative decreases it (sale). */
  qtyChange: number;
  type: StockMovementType;
  /** The document that caused the change, e.g. "OPENING", "GR-000001", "SAL-000001". */
  sourceDocument: string;
  /** The mandatory reason for a manager adjustment (INV-05); omit for every other movement kind. */
  reason?: string | null;
  /** Who caused it. Null only for system-seeded opening balances. */
  actorId: string | null;
}

export interface PostedMovement {
  id: string;
  balanceBefore: number;
  balanceAfter: number;
}

/**
 * The shared, transaction-safe way every document posts stock (#5). Downstream feature modules
 * (#6 adjustments, #9 goods receipts, #14 sales) inject this service rather than touching
 * `StockMovement`/`StockBalance` directly, so the append-only ledger, the never-negative invariant
 * and atomic post-and-stock are enforced in exactly one place.
 */
@Injectable()
export class StockPostingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Post one movement and update its balance in a single transaction. The matching balance row is
   * locked (`SELECT ... FOR UPDATE`) so concurrent posts on the same product+store serialize; a
   * change that would make the balance negative is rejected and no row is written. The movement
   * snapshots the before/after balances. Posting also locks the product's SKU against edits
   * (MD-01) the first time a transaction references it.
   *
   * Pass `tx` to post inside a wider transaction (so a document and its movement commit or roll
   * back together); omit it to run the post in its own transaction.
   */
  async post(input: PostMovementInput, tx?: StockTxClient): Promise<PostedMovement> {
    if (tx) return this.postWithin(tx, input);
    return this.prisma.$transaction((client) =>
      this.postWithin(client as unknown as StockTxClient, input),
    );
  }

  private async postWithin(tx: StockTxClient, input: PostMovementInput): Promise<PostedMovement> {
    // Lock the balance row for this product+store so concurrent posts take turns (INV-04). The
    // raw lock runs first; the subsequent reads/writes see the locked, authoritative row.
    const locked = await tx.$queryRaw<{ id: string; quantity: number }[]>`
      SELECT "id", "quantity" FROM "StockBalance"
      WHERE "productId" = ${input.productId} AND "storeId" = ${input.storeId}
      FOR UPDATE
    `;

    const balanceBefore = locked[0]?.quantity ?? 0;
    const balanceAfter = balanceBefore + input.qtyChange;
    if (balanceAfter < 0) {
      throw new ORPCError('CONFLICT', { message: INSUFFICIENT_STOCK_MESSAGE });
    }

    if (locked[0]) {
      await tx.stockBalance.update({
        where: { id: locked[0].id },
        data: { quantity: balanceAfter },
      });
    } else {
      await tx.stockBalance.create({
        data: { productId: input.productId, storeId: input.storeId, quantity: balanceAfter },
      });
    }

    const movement = await tx.stockMovement.create({
      data: {
        productId: input.productId,
        storeId: input.storeId,
        qtyChange: input.qtyChange,
        balanceBefore,
        balanceAfter,
        type: input.type,
        sourceDocument: input.sourceDocument,
        reason: input.reason ?? null,
        actorId: input.actorId,
      },
    });

    // The product now has transaction history: freeze its SKU (MD-01). Idempotent.
    await tx.product.update({
      where: { id: input.productId },
      data: { skuLocked: true },
    });

    return { id: movement.id, balanceBefore, balanceAfter };
  }

  /**
   * Allocate the next unique document number for a prefix (Section 4.3), e.g. "GR" → "GR-000001".
   * The per-prefix counter is incremented atomically and the issued number is recorded in a table
   * keyed by the number itself, so the database rejects any attempt to issue the same number
   * twice. Call inside the posting transaction so a number is never consumed without its document.
   */
  async allocateDocumentNumber(prefix: string, tx?: StockTxClient): Promise<string> {
    if (tx) return this.allocateWithin(tx, prefix);
    return this.prisma.$transaction((client) =>
      this.allocateWithin(client as unknown as StockTxClient, prefix),
    );
  }

  private async allocateWithin(tx: StockTxClient, prefix: string): Promise<string> {
    // `nextValue` holds the sequence to issue next; the schema default is 1, so a counter sitting
    // at the default (whether created here or pre-seeded elsewhere) issues 1 first. Read-and-bump
    // atomically: create seeds the row one past the first issued number (2), update increments it.
    // The issued sequence is `nextValue - 1`, clamped to 1 so a row left at the default 1 still
    // issues 1 rather than 0 — the schema default and this allocator agree on the first number.
    const counter = await tx.documentCounter.upsert({
      where: { prefix },
      update: { nextValue: { increment: 1 } },
      create: { prefix, nextValue: 2 },
      select: { nextValue: true },
    });
    const sequence = Math.max(counter.nextValue - 1, 1);
    const number = `${prefix}-${String(sequence).padStart(6, '0')}`;
    // The primary key is the number: a duplicate insert is rejected by the database (P2002).
    await tx.issuedDocumentNumber.create({ data: { number, prefix } });
    return number;
  }
}

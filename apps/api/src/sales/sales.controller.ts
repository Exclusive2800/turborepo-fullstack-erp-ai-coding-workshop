import { Controller } from '@nestjs/common';
import {
  contract,
  NOT_FOUND_MESSAGE,
  PRODUCT_INACTIVE_MESSAGE,
  type Sale,
  SALE_NOT_CONFIRMABLE_MESSAGE,
  type SaleLine,
  saleInsufficientStockMessage,
  type Whoami,
} from '@erp/contracts';
import { Implement, implement, ORPCError } from '@orpc/nest';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { assertStoreScope, resolveStoreScope } from '../auth/store-scope.js';
import { PrismaService } from '../database/prisma.service.js';
import { isUniqueConstraintError } from '../database/prisma-errors.js';
import { StockPostingService, type StockTxClient } from '../stock/stock-posting.service.js';

/** A Decimal-like value Prisma returns for a money column. */
interface MoneyValue {
  toFixed: (digits: number) => string;
}

/** A stored sale line row as Prisma returns it (money as Decimal). */
interface SaleLineRow {
  id: string;
  productId: string;
  sku: string;
  productName: string;
  quantity: number;
  unitPrice: MoneyValue;
  lineTotal: MoneyValue;
}

/** A stored sale row with its lines, as Prisma returns it. */
interface SaleRow {
  id: string;
  storeId: string;
  status: Sale['status'];
  total: MoneyValue;
  documentNumber: string | null;
  confirmedAt: Date | null;
  lines: SaleLineRow[];
  createdAt: Date;
  updatedAt: Date;
}

function serializeLine(row: SaleLineRow): SaleLine {
  return {
    id: row.id,
    productId: row.productId,
    sku: row.sku,
    productName: row.productName,
    quantity: row.quantity,
    unitPrice: row.unitPrice.toFixed(2),
    lineTotal: row.lineTotal.toFixed(2),
  };
}

/** Prisma returns Decimals and Dates; the contract expects money strings and ISO timestamps. */
function serializeSale(row: SaleRow): Sale {
  return {
    id: row.id,
    storeId: row.storeId,
    status: row.status,
    total: row.total.toFixed(2),
    documentNumber: row.documentNumber,
    confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
    lines: row.lines.map(serializeLine),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Round money to two decimals as an integer count of satang, then back to a fixed string. */
function toMoney(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

@Controller()
export class SalesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: StockPostingService,
  ) {}

  @Implement(contract.sale.list)
  list() {
    return implement(contract.sale.list).handler(async ({ input }) => {
      const { page, pageSize } = input;
      const [rows, total] = await Promise.all([
        this.prisma.sale.findMany({
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: { lines: true },
        }) as Promise<SaleRow[]>,
        this.prisma.sale.count(),
      ]);
      return { items: rows.map(serializeSale), total, page, pageSize };
    });
  }

  @Implement(contract.sale.get)
  get() {
    return implement(contract.sale.get).handler(async ({ input }) => {
      const row = (await this.prisma.sale.findUnique({
        where: { id: input.id },
        include: { lines: true },
      })) as SaleRow | null;
      if (!row) {
        throw new ORPCError('NOT_FOUND', { message: NOT_FOUND_MESSAGE });
      }
      return serializeSale(row);
    });
  }

  /**
   * Create a draft sale (SAL-01, SAL-02). Only a STAFF employee reaches this handler
   * (`@Roles('STAFF')`). The store is derived from the authenticated principal
   * ({@link resolveStoreScope} with no requested store → the staff's assigned store), never from
   * the request body; an unassigned staff user is rejected. Per-line positive-whole-number
   * quantities and the duplicate-product rule are enforced at the contract boundary.
   *
   * Controlled pricing (SAL-02): the handler reads each product's *current* selling price
   * server-side and snapshots it onto the line — the client cannot supply or override a price (the
   * contract strips any `unitPrice` it sends). It additionally rejects a deactivated product (MD-02:
   * active-only for *new* documents) and a missing product, then snapshots each product's name/SKU
   * and computes `lineTotal = quantity × unitPrice` and the sale `total`.
   *
   * A draft sale never touches stock (SAL-03): no `StockMovement` is written and no `StockBalance`
   * changes, and no document number is allocated — only confirmation (#14) moves inventory. The
   * status is always DRAFT; #14 owns the transition to CONFIRMED.
   */
  @Roles('STAFF')
  @Implement(contract.sale.create)
  create(@CurrentUser() user: Whoami) {
    return implement(contract.sale.create).handler(async ({ input }) => {
      // Derive the store from the principal, never the body. A STAFF user gets their assigned store
      // (and is rejected with FORBIDDEN if they are not assigned to one).
      const storeId = resolveStoreScope(user, undefined);

      // Read the current selling price and master fields for each line's product, and reject any
      // deactivated or missing product up front.
      const products = await this.prisma.product.findMany({
        where: { id: { in: input.lines.map((line) => line.productId) } },
        select: { id: true, sku: true, name: true, active: true, sellingPrice: true },
      });
      const productById = new Map(products.map((product) => [product.id, product]));

      const lineData = input.lines.map((line) => {
        const product = productById.get(line.productId);
        if (!product) {
          throw new ORPCError('NOT_FOUND', { message: NOT_FOUND_MESSAGE });
        }
        // MD-02: a deactivated product cannot be added to a *new* document.
        if (!product.active) {
          throw new ORPCError('CONFLICT', { message: PRODUCT_INACTIVE_MESSAGE });
        }
        // SAL-02: the unit price is the product's current selling price, read server-side — never
        // a client-supplied value.
        const unitPrice = product.sellingPrice.toFixed(2);
        const lineTotal = toMoney(line.quantity * Number(unitPrice));
        return {
          productId: line.productId,
          sku: product.sku,
          productName: product.name,
          quantity: line.quantity,
          unitPrice,
          lineTotal,
        };
      });

      const total = toMoney(lineData.reduce((sum, line) => sum + Number(line.lineTotal), 0));

      const row = (await this.prisma.sale.create({
        data: {
          status: 'DRAFT',
          storeId,
          createdById: user.id,
          total,
          lines: { create: lineData },
        },
        include: { lines: true },
      })) as SaleRow;

      return serializeSale(row);
    });
  }

  /**
   * Confirm a draft sale (SAL-03, AC-05/AC-06, #14) — the idempotency/atomicity twin of goods
   * receipt confirmation (#11). Only a STAFF employee reaches this handler (`@Roles('STAFF')`), and
   * only for a sale in their assigned store (store scope derived from the principal, never the body).
   *
   * Idempotency (reuses the #11 mechanism): the request may carry a client-supplied `idempotencyKey`,
   * UNIQUE-constrained on `Sale` in the database. If a sale with that key already exists, the original
   * confirmed sale is returned and nothing is written — a double click or a retried request after a
   * flaky network never deducts stock twice. The unique constraint, not this in-memory lookup, is the
   * source of truth: two requests racing in parallel resolve to one confirmation (the loser's insert
   * hits P2002 and replays the winner). The pre-check only spares the common retry a transaction.
   *
   * Stock validation + naming (AC-05): confirmation reads the latest balance for every line's product
   * in the sale's store and, if any line would drive stock negative, rejects the WHOLE document —
   * nothing posted, no deduction — naming every short product by SKU so the user knows which lines to
   * fix. This pre-transaction check is the friendly rejection; the binding never-negative guard runs
   * inside the posting service under a row lock, so concurrent confirmations cannot both pass it.
   *
   * Atomic post-and-deduct (AC-06): in one transaction it allocates the unique "SAL" document number,
   * posts one SALE `StockMovement` per line (negative `qtyChange`) through the shared posting service
   * — which locks each balance row, re-validates never-negative, and lowers the balance — then
   * transitions the sale to CONFIRMED with its number and confirmation timestamp. Either the whole
   * confirmation commits or nothing does.
   */
  @Roles('STAFF')
  @Implement(contract.sale.confirm)
  confirm(@CurrentUser() user: Whoami) {
    return implement(contract.sale.confirm).handler(async ({ input }) => {
      // Idempotency replay (fast path): a key that already has a sale returns that sale untouched,
      // before the draft is loaded or any movement posted. The key is globally unique, so it maps to
      // exactly one sale regardless of order.
      if (input.idempotencyKey) {
        const replay = await this.findSaleByKey(input.idempotencyKey);
        if (replay) return replay;
      }

      const sale = (await this.prisma.sale.findUnique({
        where: { id: input.id },
        include: { lines: true },
      })) as SaleRow | null;
      if (!sale) {
        throw new ORPCError('NOT_FOUND', { message: NOT_FOUND_MESSAGE });
      }

      // The store is the sale's store (derived from the principal at creation, #13); a STAFF user may
      // only confirm a sale for their assigned store.
      assertStoreScope(user, sale.storeId);

      // Only a Draft can be confirmed. A Confirmed sale is terminal (immutability is #16's concern);
      // confirming it again without a matching key is a conflict, not a silent no-op.
      if (sale.status !== 'DRAFT') {
        throw new ORPCError('CONFLICT', { message: SALE_NOT_CONFIRMABLE_MESSAGE });
      }

      // Stock validation (AC-05): read the latest balance for every line and collect the SKUs that
      // are short against the request-time snapshot. If any line is short, reject the whole document
      // naming them — nothing is posted. The authoritative never-negative check is inside the posting
      // transaction below, so a concurrent confirmation cannot slip past this.
      const balances = await Promise.all(
        sale.lines.map((line) =>
          this.prisma.stockBalance.findUnique({
            where: { productId_storeId: { productId: line.productId, storeId: sale.storeId } },
            select: { quantity: true },
          }),
        ),
      );
      const shortSkus = sale.lines
        .filter((line, index) => (balances[index]?.quantity ?? 0) < line.quantity)
        .map((line) => line.sku);
      if (shortSkus.length > 0) {
        throw new ORPCError('CONFLICT', { message: saleInsufficientStockMessage(shortSkus) });
      }

      try {
        const outcome = await this.prisma.$transaction(async (tx) => {
          const txClient = tx as unknown as StockTxClient;
          const client = tx as typeof this.prisma;

          // Authoritative concurrency guard (AC-06, SAL exactly-one-wins). Confirmation UPDATES an
          // existing draft rather than inserting a new row, so — unlike goods receipt #11 — the
          // unique idempotency key alone does not serialize two confirms of the SAME draft (both
          // update one row, no P2002). Lock the sale row with `SELECT ... FOR UPDATE` so concurrent
          // confirmations of this draft take turns, then re-read its status under the lock. The
          // second caller blocks until the first commits and then sees CONFIRMED — it posts nothing
          // and replays the committed sale. The lock is taken before any number is allocated, so the
          // loser never consumes a document number.
          const locked = await client.$queryRaw<{ status: string }[]>`
            SELECT "status" FROM "Sale" WHERE "id" = ${sale.id} FOR UPDATE
          `;
          if (locked[0]?.status !== 'DRAFT') {
            // Already confirmed by the winner while we waited on the lock — replay, don't re-post.
            return { replayed: true as const };
          }

          // Allocate the unique "SAL" document number inside the transaction so a number is never
          // consumed without its confirmed sale.
          const number = await this.posting.allocateDocumentNumber('SAL', txClient);

          // One SALE movement per line, negative qtyChange, into the sale's store. The posting
          // service locks each balance row and re-validates never-negative under the lock, so this is
          // the authoritative atomic deduction (AC-06) — the whole confirmation rolls back if any line
          // would go negative.
          for (const line of sale.lines) {
            await this.posting.post(
              {
                productId: line.productId,
                storeId: sale.storeId,
                qtyChange: -line.quantity,
                type: 'SALE',
                sourceDocument: number,
                actorId: user.id,
              },
              txClient,
            );
          }

          // Transition the draft to CONFIRMED with its number, confirmation timestamp and key.
          await client.sale.update({
            where: { id: sale.id },
            data: {
              status: 'CONFIRMED',
              documentNumber: number,
              confirmedAt: new Date(),
              idempotencyKey: input.idempotencyKey ?? null,
            },
          });
          return { replayed: false as const };
        });

        // The loser of a concurrent confirm (lock showed CONFIRMED): return the committed sale the
        // winner wrote, rather than re-posting. The sale is now confirmed exactly once.
        if (outcome.replayed) {
          const current = (await this.prisma.sale.findUnique({
            where: { id: sale.id },
            include: { lines: true },
          })) as SaleRow | null;
          if (current) return serializeSale(current);
          throw new ORPCError('CONFLICT', { message: SALE_NOT_CONFIRMABLE_MESSAGE });
        }
      } catch (error) {
        // Belt-and-braces: if a key race still surfaced a unique-constraint violation, replay the
        // winner. The whole transaction (number, movements, status) rolled back, so nothing was
        // deducted twice.
        if (input.idempotencyKey && isUniqueConstraintError(error)) {
          const replay = await this.findSaleByKey(input.idempotencyKey);
          if (replay) return replay;
        }
        throw error;
      }

      const row = (await this.prisma.sale.findUnique({
        where: { id: sale.id },
        include: { lines: true },
      })) as SaleRow | null;
      if (!row) {
        throw new ORPCError('NOT_FOUND', { message: NOT_FOUND_MESSAGE });
      }
      return serializeSale(row);
    });
  }

  /**
   * Look up a confirmed sale by its idempotency key (#14), or null if there is none yet. The key is
   * globally UNIQUE on `Sale` (the mechanism reused from goods receipt #11), so a key identifies
   * exactly one sale. Used both for the pre-transaction replay fast path and to resolve a concurrent
   * P2002 loser back to the winner's sale, so a replay is byte-for-byte the original response.
   */
  private async findSaleByKey(idempotencyKey: string): Promise<Sale | null> {
    const row = (await this.prisma.sale.findUnique({
      where: { idempotencyKey },
      include: { lines: true },
    })) as SaleRow | null;
    return row ? serializeSale(row) : null;
  }
}

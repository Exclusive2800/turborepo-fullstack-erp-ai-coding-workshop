import { Controller } from '@nestjs/common';
import {
  contract,
  NOT_FOUND_MESSAGE,
  type StockItem,
  type StockMovement,
  type StockMovementListInput,
  type StockSearchInput,
  type Whoami,
} from '@erp/contracts';
import { Implement, implement, ORPCError } from '@orpc/nest';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';
import { StockPostingService } from './stock-posting.service.js';

/** A balance row joined to the product and store fields the search result needs. */
interface BalanceRow {
  productId: string;
  storeId: string;
  quantity: number;
  product: { sku: string; name: string; unit: string };
  store: { code: string };
}

/** A ledger row as Prisma returns it (timestamp as a Date). */
interface MovementRow {
  id: string;
  productId: string;
  storeId: string;
  qtyChange: number;
  balanceBefore: number;
  balanceAfter: number;
  type: StockMovement['type'];
  sourceDocument: string;
  reason: string | null;
  actorId: string | null;
  createdAt: Date;
}

function serializeMovement(row: MovementRow): StockMovement {
  return {
    id: row.id,
    productId: row.productId,
    storeId: row.storeId,
    qtyChange: row.qtyChange,
    balanceBefore: row.balanceBefore,
    balanceAfter: row.balanceAfter,
    type: row.type,
    sourceDocument: row.sourceDocument,
    reason: row.reason ?? null,
    actorId: row.actorId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Build the balance `where` clause from the search filters (INV-01). */
function searchWhere(input: StockSearchInput) {
  const where: Record<string, unknown> = {};
  if (input.storeId) where.storeId = input.storeId;
  if (input.query) {
    where.product = {
      OR: [
        { sku: { contains: input.query, mode: 'insensitive' } },
        { name: { contains: input.query, mode: 'insensitive' } },
      ],
    };
  }
  return where;
}

/** Build the movement-history `where` clause (#19). */
function movementWhere(input: StockMovementListInput) {
  const where: Record<string, unknown> = {};
  if (input.productId) where.productId = input.productId;
  if (input.storeId) where.storeId = input.storeId;
  if (input.type) where.type = input.type;
  return where;
}

@Controller()
export class StockController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: StockPostingService,
  ) {}

  @Implement(contract.stock.search)
  search() {
    return implement(contract.stock.search).handler(async ({ input }) => {
      const where = searchWhere(input);
      const { page, pageSize } = input;
      const [rows, total] = await Promise.all([
        this.prisma.stockBalance.findMany({
          where,
          orderBy: [{ store: { code: 'asc' } }, { product: { sku: 'asc' } }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: {
            product: { select: { sku: true, name: true, unit: true } },
            store: { select: { code: true } },
          },
        }) as Promise<BalanceRow[]>,
        this.prisma.stockBalance.count({ where }),
      ]);

      // Resolve the per-store reorder threshold for exactly the products/stores in this page.
      const thresholds = (await this.prisma.productStoreThreshold.findMany({
        where: {
          OR: rows.map((r) => ({ productId: r.productId, storeId: r.storeId })),
        },
        select: { productId: true, storeId: true, threshold: true },
      })) as { productId: string; storeId: string; threshold: number }[];
      const thresholdOf = new Map(
        thresholds.map((t) => [`${t.productId}:${t.storeId}`, t.threshold]),
      );

      const items: StockItem[] = rows.map((row) => {
        const threshold = thresholdOf.get(`${row.productId}:${row.storeId}`) ?? null;
        return {
          productId: row.productId,
          sku: row.product.sku,
          name: row.product.name,
          unit: row.product.unit,
          storeId: row.storeId,
          storeCode: row.store.code,
          quantity: row.quantity,
          reorderThreshold: threshold,
          // Low-stock (AC-08) only when a threshold exists and quantity is at or below it.
          lowStock: threshold !== null && row.quantity <= threshold,
        };
      });
      return { items, total, page, pageSize };
    });
  }

  @Implement(contract.stock.movements)
  movements() {
    return implement(contract.stock.movements).handler(async ({ input }) => {
      const where = movementWhere(input);
      const { page, pageSize } = input;
      const [rows, total] = await Promise.all([
        this.prisma.stockMovement.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }) as Promise<MovementRow[]>,
        this.prisma.stockMovement.count({ where }),
      ]);
      return { items: rows.map(serializeMovement), total, page, pageSize };
    });
  }

  /**
   * Manager stock adjustment with a mandatory reason (INV-05). Only a MANAGER reaches this handler
   * (`@Roles('MANAGER')`), and a manager is cross-store, so the `storeId` named in the request is
   * in scope by role — there is no per-store narrowing to do here. The signed, non-zero `qtyChange`
   * and the trimmed non-empty `reason` are validated at the contract boundary. The change is posted
   * through the one shared `StockPostingService`, which row-locks the balance, rejects a decrease
   * that would drive stock negative (INV-04) writing nothing, and appends an immutable ADJUSTMENT
   * movement recording the reason, actor and timestamp.
   */
  @Roles('MANAGER')
  @Implement(contract.stock.adjust)
  adjust(@CurrentUser() user: Whoami) {
    return implement(contract.stock.adjust).handler(async ({ input }) => {
      const posted = await this.posting.post({
        productId: input.productId,
        storeId: input.storeId,
        qtyChange: input.qtyChange,
        type: 'ADJUSTMENT',
        sourceDocument: 'ADJUSTMENT',
        reason: input.reason,
        actorId: user.id,
      });

      // Read the immutable row back so the response carries the same shape the ledger stores.
      const row = (await this.prisma.stockMovement.findUnique({
        where: { id: posted.id },
      })) as MovementRow | null;
      if (!row) {
        throw new ORPCError('NOT_FOUND', { message: NOT_FOUND_MESSAGE });
      }
      return serializeMovement(row);
    });
  }
}

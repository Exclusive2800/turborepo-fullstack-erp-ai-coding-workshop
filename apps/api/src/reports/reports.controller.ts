import { Controller } from '@nestjs/common';
import {
  contract,
  type DailySalesReport,
  type DailySalesReportInput,
  isCrossStoreRole,
  type LowStockReport,
  type MovementHistoryReport,
  type MovementHistoryReportInput,
  type MovementHistoryRow,
  reportingDayInterval,
  type StockItem,
  type StockOnHandReport,
  STORE_SCOPE_UNASSIGNED_MESSAGE,
  type Whoami,
} from '@erp/contracts';
import { Implement, implement, ORPCError } from '@orpc/nest';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';

/** The CONFIRMED-sale filter for a daily sales report (RPT-01, Section 6.2). */
function confirmedSaleWhere(input: DailySalesReportInput) {
  // The reporting day is an Asia/Bangkok calendar day; the interval is half-open in UTC
  // [from 00:00 BKK, (to+1) 00:00 BKK), keyed on the sale confirmation timestamp (user story 51).
  const { startUtc, endUtc } = reportingDayInterval(input.from, input.to);
  const where: {
    status: 'CONFIRMED';
    confirmedAt: { gte: Date; lt: Date };
    storeId?: string;
  } = {
    status: 'CONFIRMED',
    confirmedAt: { gte: startUtc, lt: endUtc },
  };
  // A manager is cross-store: no storeId means every store. When given, scope to that store.
  if (input.storeId) where.storeId = input.storeId;
  return where;
}

/** A balance row joined to the product and store fields a stock report row needs (RPT-02). */
interface ReportBalanceRow {
  productId: string;
  storeId: string;
  quantity: number;
  product: { sku: string; name: string; unit: string };
  store: { code: string };
}

/** A ledger movement joined to the product and store display fields the history row needs (RPT-03). */
interface MovementHistoryRowRaw {
  id: string;
  productId: string;
  storeId: string;
  qtyChange: number;
  balanceBefore: number;
  balanceAfter: number;
  type: MovementHistoryRow['type'];
  sourceDocument: string;
  reason: string | null;
  actorId: string | null;
  createdAt: Date;
  product: { sku: string; name: string };
  store: { code: string };
}

/**
 * Resolve the store scope for a movement-history request (RPT-03, #19), deriving it from the
 * authenticated principal and NEVER trusting the requested store alone. Returns the store id the
 * rows must be filtered to, or `null` for "every store".
 *
 * - A store-scoped role (STAFF) is pinned to its assigned store whatever `requestedStoreId` claims;
 *   if it is unassigned the request is rejected. It can never widen its view past its own store.
 * - A cross-store role (ADMIN, MANAGER, PURCHASING) sees every store (`null`), or the one store it
 *   named in the filter.
 */
function resolveMovementScope(user: Whoami, requestedStoreId: string | undefined): string | null {
  if (!isCrossStoreRole(user.role)) {
    if (!user.assignedStoreId) {
      throw new ORPCError('FORBIDDEN', { message: STORE_SCOPE_UNASSIGNED_MESSAGE });
    }
    return user.assignedStoreId;
  }
  return requestedStoreId ?? null;
}

/**
 * Build the `where` clause for the movement-history report (RPT-03, #19): the authoritative store
 * scope plus the optional product, movement-type and half-open Bangkok date-range filters. The
 * store comes from {@link resolveMovementScope}, not the request body. When both `from` and `to` are
 * given the range is the half-open Bangkok interval {@link reportingDayInterval} computes, keyed on
 * the movement timestamp; a single open bound filters only that side.
 */
function movementHistoryWhere(input: MovementHistoryReportInput, scopedStoreId: string | null) {
  const where: Record<string, unknown> = {};
  if (scopedStoreId) where.storeId = scopedStoreId;
  if (input.productId) where.productId = input.productId;
  if (input.type) where.type = input.type;
  if (input.from !== undefined || input.to !== undefined) {
    // Anchor each supplied bound to the Asia/Bangkok reporting day: `from` to that day's 00:00 BKK
    // (inclusive) and `to` to the next Bangkok midnight (exclusive). An open bound is left off.
    const createdAt: { gte?: Date; lt?: Date } = {};
    if (input.from !== undefined) {
      createdAt.gte = reportingDayInterval(input.from, input.from).startUtc;
    }
    if (input.to !== undefined) {
      createdAt.lt = reportingDayInterval(input.to, input.to).endUtc;
    }
    where.createdAt = createdAt;
  }
  return where;
}

/**
 * Build the `where` clause for a stock report (RPT-02): optional store scope and a case-insensitive
 * SKU-or-name search. Zero-stock rows are NOT filtered out — a product at balance 0 that matches the
 * search stays visible (user story 47).
 */
function reportBalanceWhere(storeId: string | undefined, query: string | undefined) {
  const where: Record<string, unknown> = {};
  if (storeId) where.storeId = storeId;
  if (query) {
    where.product = {
      OR: [
        { sku: { contains: query, mode: 'insensitive' } },
        { name: { contains: query, mode: 'insensitive' } },
      ],
    };
  }
  return where;
}

@Controller()
export class ReportsController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Read the on-hand balance rows for the filters and resolve each product/store's per-store reorder
   * threshold, mapping to the shared {@link StockItem} shape (INV-01). A row is low-stock only when a
   * threshold exists for that product in that store and the on-hand quantity is AT OR BELOW it
   * (`quantity <= threshold`) — the same rule the stock-search screen uses, so a product at balance 0
   * with threshold 3 is low-stock because 0 ≤ 3. Rows are ordered by store code then SKU.
   *
   * The report enumerates maintained `StockBalance` rows: a product is represented by its balance row
   * (including an explicit zero-quantity row, which the seed and the ledger write for every
   * product/store), so an absent balance row means the product is simply not reported for that store.
   */
  private async onHandRows(
    storeId: string | undefined,
    query: string | undefined,
  ): Promise<StockItem[]> {
    const where = reportBalanceWhere(storeId, query);
    const rows = (await this.prisma.stockBalance.findMany({
      where,
      orderBy: [{ store: { code: 'asc' } }, { product: { sku: 'asc' } }],
      include: {
        product: { select: { sku: true, name: true, unit: true } },
        store: { select: { code: true } },
      },
    })) as ReportBalanceRow[];

    if (rows.length === 0) return [];

    // Resolve the per-store reorder threshold for exactly the products/stores on this report.
    const thresholds = (await this.prisma.productStoreThreshold.findMany({
      where: { OR: rows.map((r) => ({ productId: r.productId, storeId: r.storeId })) },
      select: { productId: true, storeId: true, threshold: true },
    })) as { productId: string; storeId: string; threshold: number }[];
    const thresholdOf = new Map(
      thresholds.map((t) => [`${t.productId}:${t.storeId}`, t.threshold]),
    );

    return rows.map((row) => {
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
  }

  /**
   * Daily sales report over an Asia/Bangkok reporting-day range (RPT-01, user story 46/51, AC-08
   * sales-zero half). Open to MANAGER (`@Roles('MANAGER')`). Counts only CONFIRMED sales whose
   * confirmation timestamp falls in the half-open Bangkok interval, optionally scoped to one store,
   * and returns the document count, the units sold across their lines and the summed amount.
   *
   * The reporting-day boundary is computed once by the shared helper so a sale confirmed near
   * Bangkok midnight lands in the correct day. Every figure is zero (`amount` `"0.00"`) when nothing
   * matches — the empty state the report screen renders with a Thai message.
   */
  @Roles('MANAGER')
  @Implement(contract.report.dailySales)
  dailySales() {
    return implement(contract.report.dailySales).handler(async ({ input }) => {
      const where = confirmedSaleWhere(input);

      // Document count + summed amount over the confirmed sales, and units summed over their lines.
      const [sales, lines] = await Promise.all([
        this.prisma.sale.aggregate({
          where,
          _count: { _all: true },
          _sum: { total: true },
        }),
        this.prisma.saleLine.aggregate({
          where: { sale: where },
          _sum: { quantity: true },
        }),
      ]);

      const amount = sales._sum.total ? sales._sum.total.toFixed(2) : '0.00';
      const report: DailySalesReport = {
        from: input.from,
        to: input.to,
        storeId: input.storeId ?? null,
        documentCount: sales._count._all,
        unitsSold: lines._sum.quantity ?? 0,
        amount,
      };
      return report;
    });
  }

  /**
   * Stock-on-hand report by store with product search (RPT-02, user story 47). Open to any
   * permitted user (no `@Roles`), like stock search. Returns the per-store on-hand rows that match
   * the optional store and SKU-or-name search, each with its reorder threshold and low-stock flag.
   * Zero-stock matches stay visible. An empty list is the empty state the screen renders.
   */
  @Implement(contract.report.stockOnHand)
  stockOnHand() {
    return implement(contract.report.stockOnHand).handler(async ({ input }) => {
      const items = await this.onHandRows(input.storeId, input.query);
      const report: StockOnHandReport = {
        storeId: input.storeId ?? null,
        items,
        total: items.length,
      };
      return report;
    });
  }

  /**
   * Low-stock report for one store (RPT-02, AC-08 low-stock half). Open to any permitted user. The
   * store is required because low stock is defined against the per-store reorder threshold. Returns
   * only the rows whose on-hand is AT OR BELOW their threshold (`quantity <= threshold`) — so SKU003
   * at balance 0 with threshold 3 appears because 0 ≤ 3. A product with no threshold for the store
   * is never low-stock. An empty list is the empty state the screen renders.
   */
  @Implement(contract.report.lowStock)
  lowStock() {
    return implement(contract.report.lowStock).handler(async ({ input }) => {
      const items = (await this.onHandRows(input.storeId, input.query)).filter(
        (item) => item.lowStock,
      );
      const report: LowStockReport = {
        storeId: input.storeId,
        items,
        total: items.length,
      };
      return report;
    });
  }

  /**
   * Movement-history report over the append-only stock ledger (RPT-03, #19). A read-only, paginated,
   * newest-first view of every stock movement — OPENING, ADJUSTMENT (#6), GOODS_RECEIPT (#9/#11) and
   * SALE (#14) — each row carrying its signed quantity change, the resulting balance, the movement
   * type, the source document that caused it and the timestamp. Open to any signed-in user (no
   * `@Roles`), like the stock reports.
   *
   * Store scope is derived from the authenticated principal, never the request body: a STAFF caller
   * only ever receives movements for their assigned store (whatever `storeId` the request names),
   * and a cross-store role (MANAGER) receives movements across every store, or one store if they
   * name it in the filter. The product, type and half-open Bangkok date-range filters narrow within
   * that scope. An empty page is the empty state the screen renders with a Thai message.
   */
  @Implement(contract.report.movementHistory)
  movementHistory(@CurrentUser() user: Whoami) {
    return implement(contract.report.movementHistory).handler(async ({ input }) => {
      const scopedStoreId = resolveMovementScope(user, input.storeId);
      const where = movementHistoryWhere(input, scopedStoreId);
      const { page, pageSize } = input;

      const [rows, total] = await Promise.all([
        this.prisma.stockMovement.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: {
            product: { select: { sku: true, name: true } },
            store: { select: { code: true } },
          },
        }) as Promise<MovementHistoryRowRaw[]>,
        this.prisma.stockMovement.count({ where }),
      ]);

      const items: MovementHistoryRow[] = rows.map((row) => ({
        id: row.id,
        productId: row.productId,
        sku: row.product.sku,
        productName: row.product.name,
        storeId: row.storeId,
        storeCode: row.store.code,
        qtyChange: row.qtyChange,
        balanceBefore: row.balanceBefore,
        balanceAfter: row.balanceAfter,
        type: row.type,
        sourceDocument: row.sourceDocument,
        reason: row.reason ?? null,
        actorId: row.actorId,
        createdAt: row.createdAt.toISOString(),
      }));

      const report: MovementHistoryReport = {
        storeId: scopedStoreId,
        items,
        total,
        page,
        pageSize,
      };
      return report;
    });
  }
}

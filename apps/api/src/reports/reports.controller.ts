import { Controller } from '@nestjs/common';
import {
  contract,
  type DailySalesReport,
  type DailySalesReportInput,
  type LowStockReport,
  reportingDayInterval,
  type StockItem,
  type StockOnHandReport,
} from '@erp/contracts';
import { Implement, implement } from '@orpc/nest';
import { Roles } from '../auth/auth.decorators.js';
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
}

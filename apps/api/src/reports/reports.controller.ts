import { Controller } from '@nestjs/common';
import {
  contract,
  type DailySalesReport,
  type DailySalesReportInput,
  reportingDayInterval,
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

@Controller()
export class ReportsController {
  constructor(private readonly prisma: PrismaService) {}

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
}

import { oc } from '@orpc/contract';
import { DateTime } from 'luxon';
import * as z from 'zod';
import { REPORT_DATE_RANGE_INVALID_MESSAGE } from './errors.js';
import { StockItemSchema } from './stock.js';

/**
 * The reporting time zone (TOR Section 2, 6.2). Every reporting-day boundary is computed in
 * Asia/Bangkok (UTC+7, no DST), never the server's local zone. Timestamps are stored in UTC and
 * converted here only at the reporting boundary.
 */
export const REPORTING_TIME_ZONE = 'Asia/Bangkok' as const;

/** A calendar date, `YYYY-MM-DD`, interpreted as an Asia/Bangkok reporting day. */
const ReportingDateSchema = z.iso.date();

/** The half-open UTC interval a reporting-day range covers (end exclusive). */
export interface ReportingInterval {
  /** 00:00:00 Asia/Bangkok on `from`, as a UTC instant — inclusive. */
  startUtc: Date;
  /** 00:00:00 Asia/Bangkok on the day AFTER `to`, as a UTC instant — exclusive. */
  endUtc: Date;
}

/**
 * The half-open reporting interval `[from 00:00 BKK, (to+1) 00:00 BKK)` for an inclusive
 * Asia/Bangkok date range (RPT-01, Section 6.2, user story 51). Both bounds are `YYYY-MM-DD`
 * Bangkok calendar days; the returned instants are UTC so a handler can filter `confirmedAt`
 * directly (`confirmedAt >= startUtc AND confirmedAt < endUtc`).
 *
 * The end is EXCLUSIVE and anchored on the day after `to`, so a sale confirmed at 23:30 Bangkok on
 * the last day still falls inside the range while the next Bangkok midnight does not — the single
 * correctness point of #17. The conversion is explicit (Luxon interprets the date in
 * {@link REPORTING_TIME_ZONE}); it never relies on the server's local zone.
 *
 * Reused by the other reports (#18, #19, #20) so the reporting-day boundary is defined once.
 */
export function reportingDayInterval(from: string, to: string): ReportingInterval {
  const start = DateTime.fromISO(from, { zone: REPORTING_TIME_ZONE }).startOf('day');
  // End of the range is the START of the day AFTER `to`: half-open, so the last day is fully
  // included up to but not including the next Bangkok midnight.
  const endExclusive = DateTime.fromISO(to, { zone: REPORTING_TIME_ZONE })
    .startOf('day')
    .plus({ days: 1 });
  return { startUtc: start.toJSDate(), endUtc: endExclusive.toJSDate() };
}

/**
 * Daily sales report filters (RPT-01). `from`/`to` are inclusive Asia/Bangkok calendar days
 * (`YYYY-MM-DD`); `to` must not precede `from`. `storeId` is optional — omitted reports across all
 * stores (a manager is cross-store). The handler counts only CONFIRMED sales whose confirmation
 * timestamp falls in the half-open Bangkok interval {@link reportingDayInterval} computes.
 */
export const DailySalesReportInputSchema = z
  .object({
    from: ReportingDateSchema,
    to: ReportingDateSchema,
    storeId: z.string().min(1).optional(),
  })
  .refine((input) => input.from <= input.to, {
    message: REPORT_DATE_RANGE_INVALID_MESSAGE,
    path: ['to'],
  });
export type DailySalesReportInput = z.infer<typeof DailySalesReportInputSchema>;

/**
 * The daily sales report result (RPT-01, AC-08 sales-zero half). A single aggregate over the
 * confirmed sales in the filtered range: how many sale documents, how many units across all their
 * lines, and the summed amount (two-decimal money string). When nothing matches, every figure is
 * zero and `amount` is `"0.00"` — the empty state the screen renders with a Thai message.
 */
export const DailySalesReportSchema = z.object({
  /** Echo of the filters the figures were computed for. */
  from: ReportingDateSchema,
  to: ReportingDateSchema,
  storeId: z.string().nullable(),
  /** Count of CONFIRMED sale documents in the range. */
  documentCount: z.number().int().nonnegative(),
  /** Total units sold across every line of those sales. */
  unitsSold: z.number().int().nonnegative(),
  /** Summed document total, two-decimal money string. `"0.00"` when nothing matches. */
  amount: z.string(),
});
export type DailySalesReport = z.infer<typeof DailySalesReportSchema>;

/**
 * Stock-on-hand report filters (RPT-02, user story 47). `storeId` is optional — omitted reports
 * every store (a cross-store user); given, it scopes to that store. `query` matches SKU or product
 * name case-insensitively. Zero-stock products that match the filters stay visible — nothing is
 * hidden for having a balance of zero. The report is a read-only view of the maintained per-store
 * `StockBalance` rows (#5), carrying each product's per-store reorder threshold and low-stock flag.
 */
export const StockOnHandReportInputSchema = z.object({
  storeId: z.string().min(1).optional(),
  query: z.string().trim().max(200).optional(),
});
export type StockOnHandReportInput = z.infer<typeof StockOnHandReportInputSchema>;

/**
 * The stock-on-hand report result (RPT-02). A flat list of per-store on-hand rows — one product in
 * one store with its quantity, unit, per-store reorder threshold and low-stock flag — ordered by
 * store code then SKU for a stable, scannable list. `total` echoes the row count. When nothing
 * matches the filters the list is empty and `total` is 0 — the empty state the screen renders with
 * a Thai message. The row shape is the shared {@link StockItemSchema} (INV-01), so the report and
 * the stock-search screen agree on what an on-hand row is.
 */
export const StockOnHandReportSchema = z.object({
  /** Echo of the store filter the rows were computed for (`null` for all stores). */
  storeId: z.string().nullable(),
  items: z.array(StockItemSchema),
  /** Count of rows in the report. */
  total: z.number().int().nonnegative(),
});
export type StockOnHandReport = z.infer<typeof StockOnHandReportSchema>;

/**
 * Low-stock report filters (RPT-02, AC-08 low-stock half). `storeId` is REQUIRED — low stock is
 * defined against the per-store reorder threshold, so the report always runs for one named store.
 * `query` matches SKU or product name case-insensitively. A product is low-stock when its on-hand
 * balance is AT OR BELOW its reorder threshold for that store (`quantity <= threshold`); a product
 * with no balance row is treated as zero on-hand, so SKU003 at balance 0 with threshold 3 is
 * low-stock because 0 ≤ 3.
 */
export const LowStockReportInputSchema = z.object({
  storeId: z.string().min(1),
  query: z.string().trim().max(200).optional(),
});
export type LowStockReportInput = z.infer<typeof LowStockReportInputSchema>;

/**
 * The low-stock report result (RPT-02, AC-08 low-stock half). The same per-store on-hand row shape
 * as the stock-on-hand report, but containing ONLY the rows that are low-stock (`quantity <=
 * reorderThreshold`), ordered by store code then SKU. Every returned row's `lowStock` is `true`.
 * When nothing is low-stock the list is empty and `total` is 0 — the empty state the screen renders.
 */
export const LowStockReportSchema = z.object({
  /** Echo of the store the low-stock rows were computed for. */
  storeId: z.string(),
  items: z.array(StockItemSchema),
  /** Count of low-stock rows. */
  total: z.number().int().nonnegative(),
});
export type LowStockReport = z.infer<typeof LowStockReportSchema>;

export const reportContract = {
  dailySales: oc
    .route({
      method: 'GET',
      path: '/reports/daily-sales',
      summary:
        'Daily sales report over an Asia/Bangkok reporting-day range: confirmed-sale document count, units and amount',
      tags: ['Reports'],
    })
    .input(DailySalesReportInputSchema)
    .output(DailySalesReportSchema),
  stockOnHand: oc
    .route({
      method: 'GET',
      path: '/reports/stock-on-hand',
      summary:
        'Stock-on-hand report by store with product search; zero-stock matches stay visible (RPT-02)',
      tags: ['Reports'],
    })
    .input(StockOnHandReportInputSchema)
    .output(StockOnHandReportSchema),
  lowStock: oc
    .route({
      method: 'GET',
      path: '/reports/low-stock',
      summary:
        'Low-stock report for a store: products whose on-hand is at or below their reorder threshold (RPT-02, AC-08)',
      tags: ['Reports'],
    })
    .input(LowStockReportInputSchema)
    .output(LowStockReportSchema),
};

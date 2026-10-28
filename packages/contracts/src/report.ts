import { oc } from '@orpc/contract';
import { DateTime } from 'luxon';
import * as z from 'zod';
import { REPORT_DATE_RANGE_INVALID_MESSAGE } from './errors.js';

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
};

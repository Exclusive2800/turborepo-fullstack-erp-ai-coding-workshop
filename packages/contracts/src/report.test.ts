import { describe, expect, it } from 'vitest';
import {
  DailySalesReportInputSchema,
  LowStockReportInputSchema,
  REPORTING_TIME_ZONE,
  reportingDayInterval,
  StockOnHandReportInputSchema,
} from './report.js';

// The half-open reporting-interval helper (RPT-01, Section 6.2, user story 51). A reporting day
// runs 00:00:00 inclusive to the next day 00:00:00 exclusive in Asia/Bangkok (UTC+7, no DST),
// keyed on the sale confirmation timestamp. Bangkok is 7 hours ahead of UTC, so Bangkok midnight on
// day D is 17:00 UTC on day D-1. These literals are worked out by hand from that offset, an
// independent source of truth — never recomputed the way the helper does.
describe('reportingDayInterval', () => {
  it('maps a single Bangkok day to its half-open UTC interval', () => {
    const { startUtc, endUtc } = reportingDayInterval('2026-01-15', '2026-01-15');
    // 2026-01-15 00:00 Bangkok = 2026-01-14 17:00 UTC.
    expect(startUtc.toISOString()).toBe('2026-01-14T17:00:00.000Z');
    // End is EXCLUSIVE: 2026-01-16 00:00 Bangkok = 2026-01-15 17:00 UTC.
    expect(endUtc.toISOString()).toBe('2026-01-15T17:00:00.000Z');
  });

  it('spans a multi-day range from the first day 00:00 to the day after the last day 00:00', () => {
    const { startUtc, endUtc } = reportingDayInterval('2026-03-01', '2026-03-03');
    // 2026-03-01 00:00 Bangkok = 2026-02-28 17:00 UTC.
    expect(startUtc.toISOString()).toBe('2026-02-28T17:00:00.000Z');
    // End exclusive = 2026-03-04 00:00 Bangkok = 2026-03-03 17:00 UTC.
    expect(endUtc.toISOString()).toBe('2026-03-03T17:00:00.000Z');
  });

  it('uses Asia/Bangkok as the reporting time zone', () => {
    expect(REPORTING_TIME_ZONE).toBe('Asia/Bangkok');
  });

  it('places a sale confirmed at 23:30 Bangkok on that Bangkok day, not the next', () => {
    // 2026-01-15 23:30 Bangkok = 2026-01-15 16:30 UTC. It must fall inside 2026-01-15's interval and
    // outside 2026-01-16's.
    const confirmedUtc = new Date('2026-01-15T16:30:00.000Z');
    const within = reportingDayInterval('2026-01-15', '2026-01-15');
    expect(confirmedUtc >= within.startUtc && confirmedUtc < within.endUtc).toBe(true);
    const next = reportingDayInterval('2026-01-16', '2026-01-16');
    expect(confirmedUtc >= next.startUtc && confirmedUtc < next.endUtc).toBe(false);
  });

  it('keeps the end boundary exclusive: next Bangkok midnight belongs to the next day', () => {
    // 2026-01-16 00:00 Bangkok = 2026-01-15 17:00 UTC is the exclusive end of the 15th and the
    // inclusive start of the 16th.
    const midnight = new Date('2026-01-15T17:00:00.000Z');
    const day15 = reportingDayInterval('2026-01-15', '2026-01-15');
    expect(midnight < day15.endUtc).toBe(false);
    const day16 = reportingDayInterval('2026-01-16', '2026-01-16');
    expect(midnight >= day16.startUtc).toBe(true);
  });
});

describe('DailySalesReportInputSchema', () => {
  it('accepts a valid date range and an optional store', () => {
    const parsed = DailySalesReportInputSchema.safeParse({
      from: '2026-01-01',
      to: '2026-01-31',
      storeId: 'store-b01',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a range with no store (all stores)', () => {
    const parsed = DailySalesReportInputSchema.safeParse({ from: '2026-01-01', to: '2026-01-31' });
    expect(parsed.success).toBe(true);
  });

  it('rejects a non date-only "from"', () => {
    const parsed = DailySalesReportInputSchema.safeParse({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-31',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a range whose end is before its start', () => {
    const parsed = DailySalesReportInputSchema.safeParse({ from: '2026-01-31', to: '2026-01-01' });
    expect(parsed.success).toBe(false);
  });
});

describe('StockOnHandReportInputSchema', () => {
  it('accepts a store and a search query', () => {
    const parsed = StockOnHandReportInputSchema.safeParse({ storeId: 'store-b01', query: 'SKU' });
    expect(parsed.success).toBe(true);
  });

  it('accepts an empty filter (all stores, no query)', () => {
    const parsed = StockOnHandReportInputSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it('trims the search query', () => {
    const parsed = StockOnHandReportInputSchema.safeParse({ query: '  SKU003  ' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.query).toBe('SKU003');
  });

  it('rejects a blank storeId', () => {
    const parsed = StockOnHandReportInputSchema.safeParse({ storeId: '' });
    expect(parsed.success).toBe(false);
  });
});

describe('LowStockReportInputSchema', () => {
  it('accepts a store and an optional query', () => {
    const parsed = LowStockReportInputSchema.safeParse({ storeId: 'store-b01', query: 'SKU003' });
    expect(parsed.success).toBe(true);
  });

  it('requires a store — low stock is defined per store', () => {
    const parsed = LowStockReportInputSchema.safeParse({ query: 'SKU003' });
    expect(parsed.success).toBe(false);
  });

  it('rejects a blank storeId', () => {
    const parsed = LowStockReportInputSchema.safeParse({ storeId: '' });
    expect(parsed.success).toBe(false);
  });
});

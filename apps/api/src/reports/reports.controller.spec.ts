import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { reportingDayInterval } from '@erp/contracts';
import { call } from '@orpc/server';
import { describe, expect, it, vi } from 'vitest';
import { ROLES_KEY } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';
import { ReportsController } from './reports.controller.js';

/** Make a Decimal-like money value as Prisma returns it from an aggregate. */
function money(value: number) {
  return { toFixed: (digits: number) => value.toFixed(digits) };
}

interface Stubs {
  /** sale.aggregate result: _count and _sum.total. */
  aggregate?: ReturnType<typeof vi.fn>;
  /** saleLine.aggregate result: _sum.quantity. */
  lineAggregate?: ReturnType<typeof vi.fn>;
}

async function createController(stubs: Stubs = {}) {
  const aggregate =
    stubs.aggregate ?? vi.fn().mockResolvedValue({ _count: { _all: 0 }, _sum: { total: null } });
  const lineAggregate =
    stubs.lineAggregate ?? vi.fn().mockResolvedValue({ _sum: { quantity: null } });
  const moduleRef = await Test.createTestingModule({
    controllers: [ReportsController],
    providers: [
      {
        provide: PrismaService,
        useValue: {
          sale: { aggregate },
          saleLine: { aggregate: lineAggregate },
        },
      },
    ],
  }).compile();
  return { controller: moduleRef.get(ReportsController), aggregate, lineAggregate };
}

describe('ReportsController', () => {
  describe('dailySales (Seam 1)', () => {
    it('counts only CONFIRMED sales in the half-open Bangkok interval and returns count, units and amount', async () => {
      const aggregate = vi
        .fn()
        .mockResolvedValue({ _count: { _all: 3 }, _sum: { total: money(455) } });
      const lineAggregate = vi.fn().mockResolvedValue({ _sum: { quantity: 9 } });
      const { controller } = await createController({ aggregate, lineAggregate });

      const result = await call(controller.dailySales(), {
        from: '2026-01-15',
        to: '2026-01-15',
        storeId: 'store-b01',
      });

      expect(result).toEqual({
        from: '2026-01-15',
        to: '2026-01-15',
        storeId: 'store-b01',
        documentCount: 3,
        unitsSold: 9,
        amount: '455.00',
      });

      // Only CONFIRMED sales, filtered by the sale's store and the half-open confirmation-timestamp
      // interval the Bangkok helper computes (end exclusive).
      const interval = reportingDayInterval('2026-01-15', '2026-01-15');
      expect(aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: 'CONFIRMED',
            storeId: 'store-b01',
            confirmedAt: { gte: interval.startUtc, lt: interval.endUtc },
          },
          _count: { _all: true },
          _sum: { total: true },
        }),
      );
      // Units are summed over the lines of those same confirmed sales.
      expect(lineAggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            sale: {
              status: 'CONFIRMED',
              storeId: 'store-b01',
              confirmedAt: { gte: interval.startUtc, lt: interval.endUtc },
            },
          },
          _sum: { quantity: true },
        }),
      );
    });

    it('reports across all stores when no storeId is given (no store filter)', async () => {
      const aggregate = vi
        .fn()
        .mockResolvedValue({ _count: { _all: 2 }, _sum: { total: money(120) } });
      const lineAggregate = vi.fn().mockResolvedValue({ _sum: { quantity: 4 } });
      const { controller } = await createController({ aggregate, lineAggregate });

      const result = await call(controller.dailySales(), { from: '2026-01-01', to: '2026-01-31' });

      expect(result.storeId).toBeNull();
      expect(result.documentCount).toBe(2);
      const where = aggregate.mock.calls[0]?.[0]?.where;
      expect(where).not.toHaveProperty('storeId');
      expect(where.status).toBe('CONFIRMED');
    });

    it('returns zero totals and "0.00" when nothing matches (AC-08 sales-zero half)', async () => {
      const { controller } = await createController();

      const result = await call(controller.dailySales(), {
        from: '2026-02-01',
        to: '2026-02-01',
        storeId: 'store-b02',
      });

      expect(result).toEqual({
        from: '2026-02-01',
        to: '2026-02-01',
        storeId: 'store-b02',
        documentCount: 0,
        unitsSold: 0,
        amount: '0.00',
      });
    });
  });

  // Authz: the daily sales report is open to MANAGER (RPT-01, user story 46).
  it('restricts the daily sales report to MANAGER', () => {
    const reflector = new Reflector();
    expect(reflector.get(ROLES_KEY, ReportsController.prototype.dailySales)).toEqual(['MANAGER']);
  });
});

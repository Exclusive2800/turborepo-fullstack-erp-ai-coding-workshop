import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createIntegrationHarness,
  type IntegrationHarness,
  isDatabaseReachable,
} from '../integration-harness.js';
import {
  dropLoadFixture,
  type LoadFixture,
  NFR_05_CONCURRENT_USERS,
  NFR_05_MOVEMENT_COUNT,
  NFR_05_P95_THRESHOLD_MS,
  NFR_05_PRODUCT_COUNT,
  percentile,
  runLoad,
  seedLoadFixture,
} from './nfr-05-load.js';

// Seam 4 (#22, NFR-05): the load test as the acceptance gate. The full Demo is a continuous
// 5-minute run driven out of band by the standalone runner (`pnpm --filter @erp/api load:nfr-05`),
// which saves the evidence artifact the handover references. This spec runs the SAME load against a
// real Postgres at the NFR-05 scale (1,000 products / 10,000 movements) and the SAME 10-user
// concurrency, but for a short, bounded duration, so the p95 ≤ 2s assertion is wired into
// `pnpm test` without a five-minute suite. When no database is reachable (the DB-less CI `check`
// job) the whole suite skips loudly, matching every other Seam-2 integration spec; the NFR-05
// assertion therefore runs locally and under the `e2e` Postgres, not on the DB-less `check` job.
const databaseReachable = await isDatabaseReachable();

// Seeding 11,000 rows plus a short load run can exceed the file default on a cold machine.
const SEED_TIMEOUT_MS = 120_000;
const RUN_TIMEOUT_MS = 60_000;
// A bounded stand-in for the 5-minute Demo: enough to drive many requests per endpoint at full
// concurrency so the p95 is meaningful, without lengthening `pnpm test`.
const BOUNDED_DURATION_MS = 5_000;

describe.skipIf(!databaseReachable)('NFR-05 load test (real Postgres)', () => {
  let harness: IntegrationHarness;
  let fixture: LoadFixture;

  beforeAll(async () => {
    harness = createIntegrationHarness();
    fixture = await seedLoadFixture(harness.prisma);
  }, SEED_TIMEOUT_MS);

  afterAll(async () => {
    if (fixture) await dropLoadFixture(harness.prisma, fixture);
    await harness.close();
  });

  it('seeds the NFR-05 scale: 1,000 products and 10,000 movements', async () => {
    expect(fixture.productIds).toHaveLength(NFR_05_PRODUCT_COUNT);
    const balances = await harness.prisma.stockBalance.count({
      where: { storeId: fixture.storeId },
    });
    expect(balances).toBe(NFR_05_PRODUCT_COUNT);
    const movements = await harness.prisma.stockMovement.count({
      where: { storeId: fixture.storeId },
    });
    expect(movements).toBe(NFR_05_MOVEMENT_COUNT);
  });

  it(
    'keeps p95 ≤ 2s for search and stock-view under 10 concurrent users',
    async () => {
      const result = await runLoad(harness.prisma, fixture, {
        durationMs: BOUNDED_DURATION_MS,
        concurrentUsers: NFR_05_CONCURRENT_USERS,
      });

      expect(result.concurrentUsers).toBe(NFR_05_CONCURRENT_USERS);
      // Both NFR-05 endpoints must have been exercised, and CSV export must not appear.
      const measured = result.endpoints.map((e) => e.endpoint).sort();
      expect(measured).toEqual(['search', 'stock-view']);

      for (const endpoint of result.endpoints) {
        // Every endpoint actually ran enough requests for a p95 to mean something.
        expect(endpoint.count).toBeGreaterThan(0);
        // The NFR-05 assertion: p95 response time no more than 2 seconds, per endpoint.
        expect(endpoint.p95Ms).toBeLessThanOrEqual(NFR_05_P95_THRESHOLD_MS);
      }
      expect(result.pass).toBe(true);
    },
    RUN_TIMEOUT_MS,
  );
});

// The percentile helper is pure, so prove it without a database — the assertion machinery itself is
// correct whether or not the integration suite runs.
describe('percentile (nearest-rank)', () => {
  it('returns 0 for an empty sample', () => {
    expect(percentile([], 95)).toBe(0);
  });

  it('computes the p95 of a uniform 1..100 sample by nearest rank', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(samples, 95)).toBe(95);
    expect(percentile(samples, 50)).toBe(50);
    expect(percentile(samples, 100)).toBe(100);
  });

  it('is order-independent', () => {
    expect(percentile([30, 10, 20, 50, 40], 95)).toBe(50);
  });
});

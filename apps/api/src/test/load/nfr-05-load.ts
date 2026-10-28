import { call } from '@orpc/server';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@erp/database';
import type { Whoami } from '@erp/contracts';
import type { PrismaService } from '../../database/prisma.service.js';
import { ReportsController } from '../../reports/reports.controller.js';
import { StockController } from '../../stock/stock.controller.js';
import { StockPostingService } from '../../stock/stock-posting.service.js';

/**
 * The NFR-05 load test (Seam 4, ticket #22, TOR NFR-05).
 *
 * NFR-05: "In an agreed test environment, support 1,000 products, 10,000 movements, and 10
 * simulated concurrent users. Search and stock-view APIs must achieve p95 response times of no
 * more than 2 seconds during a continuous 5-minute test. CSV exports are excluded."
 *
 * This is the acceptance gate, not a micro-benchmark. It drives the two named endpoints — stock
 * SEARCH (`GET /stock`, INV-01, user story 11) and the STOCK-VIEW report (`GET /reports/stock-on-hand`,
 * RPT-02, user story 47) — as the real app serves them: the real controllers wired to a real
 * Postgres through the Seam-2 integration harness, calling the oRPC handlers the same way the
 * `*.integration.spec.ts` specs do (`call(controller.x(), input)`), so the measured latency is the
 * handler + query path the HTTP layer dispatches to. CSV export is deliberately NOT exercised
 * (NFR-05 excludes it).
 *
 * It is out-of-the-ordinary-suite by design: the full Demo is a continuous 5-minute run driven by
 * the standalone runner (`pnpm --filter @erp/api load:nfr-05`), which saves the evidence artifact
 * the handover references. The colocated `*.integration.spec.ts` runs a short, bounded version at
 * the same 10-user concurrency so the p95 ≤ 2s assertion is wired into `pnpm test` and skips
 * loudly when no database is reachable (the DB-less CI `check` job), matching every other Seam-2
 * spec.
 */

/** The NFR-05 scale: 1,000 products and 10,000 ledger movements in the test store. */
export const NFR_05_PRODUCT_COUNT = 1_000;
export const NFR_05_MOVEMENT_COUNT = 10_000;
/** The NFR-05 concurrency: 10 simulated concurrent users. */
export const NFR_05_CONCURRENT_USERS = 10;
/** The NFR-05 pass threshold: p95 response time no more than 2 seconds, per endpoint. */
export const NFR_05_P95_THRESHOLD_MS = 2_000;
/** The NFR-05 Demo duration: a continuous 5-minute run. */
export const NFR_05_DURATION_MS = 5 * 60 * 1_000;

/** The endpoints NFR-05 names. CSV export is excluded on purpose and is not measured. */
export type LoadEndpoint = 'search' | 'stock-view';
export const NFR_05_ENDPOINTS: readonly LoadEndpoint[] = ['search', 'stock-view'] as const;

/** Latency statistics for one endpoint over a run, in milliseconds. */
export interface EndpointStats {
  endpoint: LoadEndpoint;
  /** Total requests completed against this endpoint. */
  count: number;
  /** Observed p95 latency in milliseconds. */
  p95Ms: number;
  /** Observed p50 (median) latency in milliseconds. */
  p50Ms: number;
  /** Slowest observed request in milliseconds. */
  maxMs: number;
  /** Whether p95 met the NFR-05 threshold (≤ 2000 ms). */
  pass: boolean;
}

/** The result of a load run: the parameters it ran under and the per-endpoint latency statistics. */
export interface LoadRunResult {
  startedAt: string;
  finishedAt: string;
  productCount: number;
  movementCount: number;
  concurrentUsers: number;
  durationMs: number;
  thresholdMs: number;
  endpoints: EndpointStats[];
  /** True only when EVERY measured endpoint met the p95 threshold. */
  pass: boolean;
}

/** Options for a load run. Defaults are the NFR-05 Demo numbers; the spec overrides the duration. */
export interface LoadRunOptions {
  /** How long to drive load continuously, in milliseconds. Default: the NFR-05 5-minute run. */
  durationMs?: number;
  /** Number of concurrent virtual users. Default: NFR-05's 10. */
  concurrentUsers?: number;
}

/** The ids a seeded NFR-05 fixture exposes, plus a sample of SKU prefixes to search for. */
export interface LoadFixture {
  storeId: string;
  productIds: string[];
  /** Case-insensitive search terms that match seeded products, for the SEARCH endpoint. */
  searchTerms: string[];
}

/**
 * The p95 (or any percentile) of a latency sample, in milliseconds, using the nearest-rank method.
 * Exported so the spec and runner report the same figure the assertion uses.
 */
export function percentile(samplesMs: number[], percentileRank: number): number {
  if (samplesMs.length === 0) return 0;
  const sorted = [...samplesMs].sort((a, b) => a - b);
  // Nearest-rank: the smallest value at or above the given percentile of the ordered sample.
  const rank = Math.ceil((percentileRank / 100) * sorted.length);
  const index = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[index] ?? 0;
}

/**
 * Seed the NFR-05 fixture: one dedicated store, {@link NFR_05_PRODUCT_COUNT} products each with a
 * per-store balance row (so the search/stock-view scans see 1,000 rows), a subset with a reorder
 * threshold (so the low-stock resolution runs), and {@link NFR_05_MOVEMENT_COUNT} ledger movements
 * distributed across the products. Everything carries a unique suffix so the fixture never collides
 * with the Section 8 seed or a parallel spec, and {@link dropLoadFixture} removes exactly it.
 *
 * The movements are inserted with `createMany` in batches for speed; the balances are the
 * authoritative on-hand rows the endpoints read, so each balance equals the net of its movements.
 */
export async function seedLoadFixture(
  prisma: PrismaClient,
  options: { productCount?: number; movementCount?: number } = {},
): Promise<LoadFixture> {
  const productCount = options.productCount ?? NFR_05_PRODUCT_COUNT;
  const movementCount = options.movementCount ?? NFR_05_MOVEMENT_COUNT;
  const suffix = randomUUID().slice(0, 8);

  const store = await prisma.store.create({
    data: { code: `NFR05-${suffix}`, name: `NFR-05 load store ${suffix}` },
  });

  // Create the products in batches, then read their ids back (createMany does not return rows).
  const productData = Array.from({ length: productCount }, (_, i) => ({
    sku: `NFR05-${suffix}-${String(i).padStart(5, '0')}`,
    name: `NFR05 ${suffix} product ${i}`,
    category: 'Load',
    unit: 'unit',
    sellingPrice: '10.00',
  }));
  await prisma.product.createMany({ data: productData });
  const products = await prisma.product.findMany({
    where: { sku: { startsWith: `NFR05-${suffix}-` } },
    select: { id: true },
    orderBy: { sku: 'asc' },
  });
  const productIds = products.map((p) => p.id);

  // One balance row per product in the store — the 1,000 rows the search/stock-view endpoints scan.
  // Give each a non-zero opening so the balances are realistic; every tenth product gets a threshold
  // so the per-store low-stock resolution the endpoints run is exercised under load.
  await prisma.stockBalance.createMany({
    data: productIds.map((productId, i) => ({
      productId,
      storeId: store.id,
      quantity: 100 + (i % 50),
    })),
  });
  await prisma.productStoreThreshold.createMany({
    data: productIds
      .filter((_, i) => i % 10 === 0)
      .map((productId) => ({ productId, storeId: store.id, threshold: 5 })),
  });

  // 10,000 movements distributed round-robin across the products. Append-only ledger rows (INV-02);
  // the balances above are the authoritative on-hand the endpoints read, so the movement history is
  // volume the ledger table carries, not something the read endpoints must reconcile per request.
  const movementData = Array.from({ length: movementCount }, (_, i) => {
    const productId = productIds[i % productIds.length] as string;
    return {
      productId,
      storeId: store.id,
      qtyChange: 1,
      balanceBefore: 0,
      balanceAfter: 1,
      type: 'OPENING' as const,
      sourceDocument: 'OPENING',
      actorId: null,
    };
  });
  const batchSize = 2_000;
  for (let i = 0; i < movementData.length; i += batchSize) {
    await prisma.stockMovement.createMany({ data: movementData.slice(i, i + batchSize) });
  }

  // Search terms that match seeded products: the shared suffix (matches all), and a handful of SKU
  // stems (match a page each), so the SEARCH endpoint runs a realistic case-insensitive filter.
  const searchTerms = [suffix, `NFR05-${suffix}-000`, `NFR05-${suffix}-001`, `product ${suffix}`];

  return { storeId: store.id, productIds, searchTerms };
}

/** Tear down exactly the fixture {@link seedLoadFixture} created. Safe on a shared, seeded database. */
export async function dropLoadFixture(prisma: PrismaClient, fixture: LoadFixture): Promise<void> {
  await prisma.stockMovement.deleteMany({ where: { storeId: fixture.storeId } });
  await prisma.productStoreThreshold.deleteMany({ where: { storeId: fixture.storeId } });
  await prisma.stockBalance.deleteMany({ where: { storeId: fixture.storeId } });
  await prisma.product.deleteMany({ where: { id: { in: fixture.productIds } } });
  await prisma.store.deleteMany({ where: { id: fixture.storeId } });
}

/**
 * Drive {@link concurrentUsers} virtual users against the SEARCH and STOCK-VIEW endpoints
 * continuously for {@link durationMs}, through the real controllers over a real Postgres, recording
 * every request's latency per endpoint and returning the per-endpoint p95 against the NFR-05
 * threshold. Each user loops issuing one SEARCH then one STOCK-VIEW request until the shared
 * deadline, so both endpoints are exercised under the full concurrency for the whole run.
 */
export async function runLoad(
  prisma: PrismaClient,
  fixture: LoadFixture,
  options: LoadRunOptions = {},
): Promise<LoadRunResult> {
  const durationMs = options.durationMs ?? NFR_05_DURATION_MS;
  const concurrentUsers = options.concurrentUsers ?? NFR_05_CONCURRENT_USERS;

  const posting = new StockPostingService(prisma as unknown as PrismaService);
  const stock = new StockController(prisma as unknown as PrismaService, posting);
  const reports = new ReportsController(prisma as unknown as PrismaService);

  // A cross-store principal naming the fixture store: the search handler resolves the scope to that
  // one store, so the measured query path is identical to the pre-scoping read (INV-01, RPT-03).
  const loadUser: Whoami = {
    id: 'nfr05-load-user',
    email: 'nfr05-load@erp.local',
    name: 'NFR-05 load user',
    role: 'MANAGER',
    assignedStoreId: null,
  };

  const latencies: Record<LoadEndpoint, number[]> = { search: [], 'stock-view': [] };
  const startedAt = new Date();
  const deadline = Date.now() + durationMs;

  async function measure(endpoint: LoadEndpoint, run: () => Promise<unknown>): Promise<void> {
    const start = performance.now();
    await run();
    latencies[endpoint].push(performance.now() - start);
  }

  async function virtualUser(seed: number): Promise<void> {
    let i = seed;
    while (Date.now() < deadline) {
      const term = fixture.searchTerms[i % fixture.searchTerms.length];
      await measure('search', () =>
        call(stock.search(loadUser), {
          page: 1,
          pageSize: 50,
          query: term,
          storeId: fixture.storeId,
        }),
      );
      await measure('stock-view', () =>
        call(reports.stockOnHand(), { storeId: fixture.storeId, query: term }),
      );
      i += 1;
    }
  }

  await Promise.all(
    Array.from({ length: concurrentUsers }, (_, userIndex) => virtualUser(userIndex)),
  );

  const finishedAt = new Date();
  const endpoints: EndpointStats[] = NFR_05_ENDPOINTS.map((endpoint) => {
    const samples = latencies[endpoint];
    const p95Ms = percentile(samples, 95);
    return {
      endpoint,
      count: samples.length,
      p95Ms,
      p50Ms: percentile(samples, 50),
      maxMs: samples.length > 0 ? samples.reduce((max, v) => (v > max ? v : max), 0) : 0,
      pass: p95Ms <= NFR_05_P95_THRESHOLD_MS,
    };
  });

  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    productCount: fixture.productIds.length,
    movementCount: NFR_05_MOVEMENT_COUNT,
    concurrentUsers,
    durationMs,
    thresholdMs: NFR_05_P95_THRESHOLD_MS,
    endpoints,
    pass: endpoints.every((e) => e.pass),
  };
}

/** Render a load run as the human-readable evidence report the handover references. */
export function formatReport(result: LoadRunResult): string {
  const lines = [
    '# NFR-05 load test report',
    '',
    `Run: ${result.startedAt} → ${result.finishedAt}`,
    `Scale: ${result.productCount} products, ${result.movementCount} movements`,
    `Concurrency: ${result.concurrentUsers} simulated concurrent users`,
    `Duration: ${Math.round(result.durationMs / 1000)}s continuous`,
    `Threshold: p95 ≤ ${result.thresholdMs} ms per endpoint (CSV export excluded)`,
    '',
    '| Endpoint | Requests | p50 (ms) | p95 (ms) | max (ms) | Result |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const e of result.endpoints) {
    lines.push(
      `| ${e.endpoint} | ${e.count} | ${e.p50Ms.toFixed(1)} | ${e.p95Ms.toFixed(1)} | ${e.maxMs.toFixed(1)} | ${e.pass ? 'PASS' : 'FAIL'} |`,
    );
  }
  lines.push('', `Overall: ${result.pass ? 'PASS' : 'FAIL'}`, '');
  return lines.join('\n');
}

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrismaClient } from '@erp/database';
import {
  dropLoadFixture,
  formatReport,
  type LoadRunResult,
  NFR_05_CONCURRENT_USERS,
  NFR_05_DURATION_MS,
  runLoad,
  seedLoadFixture,
} from '../test/load/nfr-05-load.js';

/**
 * The NFR-05 load-test runner (Seam 4, ticket #22). This is the continuous-5-minute Demo:
 *
 *   pnpm --filter @erp/api load:nfr-05
 *
 * It seeds the NFR-05 fixture (1,000 products, 10,000 movements) into a dedicated store on the
 * database `DATABASE_URL` points at, drives the SEARCH (`/stock`) and STOCK-VIEW
 * (`/reports/stock-on-hand`) endpoints with 10 concurrent users for a continuous 5-minute run,
 * writes the latency report as the evidence artifact the handover references, tears the fixture
 * down, and exits non-zero if any endpoint's p95 exceeds 2 seconds (CSV export is excluded).
 *
 * Duration and concurrency can be overridden for a quick local smoke:
 *   LOAD_DURATION_MS=5000 LOAD_CONCURRENCY=10 pnpm --filter @erp/api load:nfr-05
 */

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://erp:erp@localhost:5432/erp';
const durationMs = Number(process.env.LOAD_DURATION_MS ?? NFR_05_DURATION_MS);
const concurrentUsers = Number(process.env.LOAD_CONCURRENCY ?? NFR_05_CONCURRENT_USERS);
// The evidence artifact. Default lives under the repo-root docs so the handover can reference it.
// Resolved from this module (apps/api/src/load → repo root) so it lands in the same place whatever
// directory the script is launched from.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const reportPath = process.env.LOAD_REPORT_PATH
  ? resolve(process.env.LOAD_REPORT_PATH)
  : resolve(repoRoot, 'docs/evidence/nfr-05-load-report.md');

async function main(): Promise<void> {
  const prisma = createPrismaClient(DATABASE_URL);
  try {
    console.log(`[nfr-05] seeding fixture (1,000 products, 10,000 movements) on ${DATABASE_URL} …`);
    const fixture = await seedLoadFixture(prisma);
    try {
      console.log(
        `[nfr-05] driving ${concurrentUsers} concurrent users for ${Math.round(
          durationMs / 1000,
        )}s against search and stock-view …`,
      );
      const result: LoadRunResult = await runLoad(prisma, fixture, {
        durationMs,
        concurrentUsers,
      });

      const report = formatReport(result);
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, report, 'utf8');
      console.log(report);
      console.log(`[nfr-05] report written to ${reportPath}`);

      if (!result.pass) {
        console.error('[nfr-05] FAIL: p95 exceeded 2s on at least one endpoint.');
        process.exitCode = 1;
      } else {
        console.log('[nfr-05] PASS: p95 ≤ 2s on every measured endpoint.');
      }
    } finally {
      await dropLoadFixture(prisma, fixture);
    }
  } finally {
    await prisma.$disconnect();
  }
}

await main();

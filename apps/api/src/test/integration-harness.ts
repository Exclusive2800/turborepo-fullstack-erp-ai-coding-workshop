import { createPrismaClient, type PrismaClient } from '@erp/database';

/**
 * The real-Postgres integration harness (#5, Testing Decisions Seam 2).
 *
 * The integrity guarantees — atomic post-and-stock, never-negative, unique document numbers — are
 * behaviours a mocked `PrismaService` cannot exhibit, so the `*.integration.spec.ts` specs run the
 * real posting code against a real Postgres. This harness owns the connection and the per-test
 * reset. It talks to the same database the app uses (`DATABASE_URL`, default the compose Postgres
 * on `localhost:5432`); `pnpm db:migrate` must have been run so the schema exists.
 *
 * Downstream tickets write their own `*.integration.spec.ts` by importing `createIntegrationHarness`
 * in a `beforeAll`, calling `resetStock([productId])` in a `beforeEach`, and closing it in
 * `afterAll`.
 */
export interface IntegrationHarness {
  prisma: PrismaClient;
  /**
   * Delete the ledger rows and document counters for the given products so each test starts from a
   * clean balance. Scoped to the test's own fixture products — it never touches seeded or other
   * tests' stock, so the harness is safe to run against a shared, seeded database.
   */
  resetStock(productIds: string[]): Promise<void>;
  /** Disconnect the client. */
  close(): Promise<void>;
}

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://erp:erp@localhost:5432/erp';

/**
 * Whether a real Postgres is reachable at `DATABASE_URL` with the stock schema migrated.
 *
 * The integration specs are wired into `pnpm test`, but the CI `check` job does not (yet) run a
 * Postgres service, and a contributor may run the suite with only the app containers up. When no
 * database answers, the specs skip loudly rather than fail spuriously — they still run green
 * locally against the compose Postgres and anywhere `DATABASE_URL` points at a migrated database.
 */
export async function isDatabaseReachable(): Promise<boolean> {
  const prisma = createPrismaClient(DATABASE_URL);
  try {
    await prisma.stockBalance.count();
    return true;
  } catch (error) {
    console.warn(
      `[integration] skipping real-Postgres specs: database not reachable at ${DATABASE_URL}. ` +
        `Start it (docker compose up -d postgres) and run pnpm db:migrate. (${String(error)})`,
    );
    return false;
  } finally {
    await prisma.$disconnect();
  }
}

export function createIntegrationHarness(): IntegrationHarness {
  const prisma = createPrismaClient(DATABASE_URL);

  return {
    prisma,
    async resetStock(productIds: string[]) {
      if (productIds.length === 0) return;
      // Scope the reset to the test's own products so seeded and parallel data are untouched.
      await prisma.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.stockBalance.deleteMany({ where: { productId: { in: productIds } } });
    },
    async close() {
      await prisma.$disconnect();
    },
  };
}

/**
 * Create a throwaway product + store + user for an integration test, with a unique suffix so
 * parallel specs and the seeded fixture never collide. Returns the ids the posting calls need.
 */
export async function seedPostingFixture(
  prisma: PrismaClient,
  suffix: string,
): Promise<{ productId: string; storeId: string; userId: string }> {
  const store = await prisma.store.create({
    data: { code: `IT-${suffix}`, name: `Integration ${suffix}` },
  });
  const product = await prisma.product.create({
    data: {
      sku: `IT-SKU-${suffix}`,
      name: `Integration product ${suffix}`,
      category: 'Test',
      unit: 'unit',
      sellingPrice: '10.00',
    },
  });
  const user = await prisma.user.create({
    data: {
      email: `it-${suffix}@erp.local`,
      name: `Integration user ${suffix}`,
      role: 'MANAGER',
      passwordHash: 'x',
    },
  });
  return { productId: product.id, storeId: store.id, userId: user.id };
}

/** Tear down a fixture created by {@link seedPostingFixture}. */
export async function dropPostingFixture(
  prisma: PrismaClient,
  ids: { productId: string; storeId: string; userId: string },
): Promise<void> {
  await prisma.stockMovement.deleteMany({ where: { productId: ids.productId } });
  await prisma.stockBalance.deleteMany({ where: { productId: ids.productId } });
  await prisma.user.deleteMany({ where: { id: ids.userId } });
  await prisma.product.deleteMany({ where: { id: ids.productId } });
  await prisma.store.deleteMany({ where: { id: ids.storeId } });
}

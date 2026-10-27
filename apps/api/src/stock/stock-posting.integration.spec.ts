import { INSUFFICIENT_STOCK_MESSAGE } from '@erp/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../database/prisma.service.js';
import {
  createIntegrationHarness,
  dropPostingFixture,
  type IntegrationHarness,
  isDatabaseReachable,
  seedPostingFixture,
} from '../test/integration-harness.js';
import { StockPostingService } from './stock-posting.service.js';

// Seam 2 (#5): the real posting code over a real Postgres. Proves the database behaviours a mocked
// PrismaService cannot — atomic post-and-stock, never-negative, and unique document numbers. The
// harness resets the ledger before each test. Requires DATABASE_URL to point at a migrated database
// (the compose Postgres locally). When no database is reachable the whole suite skips loudly rather
// than fail, so the spec is wired into `pnpm test` without reddening an environment that has no DB.
const databaseReachable = await isDatabaseReachable();

describe.skipIf(!databaseReachable)('StockPostingService (real Postgres)', () => {
  let harness: IntegrationHarness;
  let service: StockPostingService;
  let fixture: { productId: string; storeId: string; userId: string };
  const suffix = `post-${Date.now()}`;

  beforeAll(async () => {
    harness = createIntegrationHarness();
    service = new StockPostingService(harness.prisma as unknown as PrismaService);
    fixture = await seedPostingFixture(harness.prisma, suffix);
  });

  afterAll(async () => {
    if (fixture) await dropPostingFixture(harness.prisma, fixture);
    if (harness) await harness.close();
  });

  beforeEach(async () => {
    await harness.resetStock([fixture.productId]);
  });

  it('posts a movement and maintains the balance in the same transaction', async () => {
    const posted = await service.post({
      productId: fixture.productId,
      storeId: fixture.storeId,
      qtyChange: 10,
      type: 'OPENING',
      sourceDocument: 'OPENING',
      actorId: null,
    });

    expect(posted).toMatchObject({ balanceBefore: 0, balanceAfter: 10 });

    const balance = await harness.prisma.stockBalance.findUnique({
      where: { productId_storeId: { productId: fixture.productId, storeId: fixture.storeId } },
    });
    expect(balance?.quantity).toBe(10);

    const movements = await harness.prisma.stockMovement.findMany({
      where: { productId: fixture.productId },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ qtyChange: 10, balanceBefore: 0, balanceAfter: 10 });
  });

  it('accumulates successive movements into the running balance', async () => {
    await service.post({
      productId: fixture.productId,
      storeId: fixture.storeId,
      qtyChange: 10,
      type: 'OPENING',
      sourceDocument: 'OPENING',
      actorId: null,
    });
    const second = await service.post({
      productId: fixture.productId,
      storeId: fixture.storeId,
      qtyChange: -4,
      type: 'SALE',
      sourceDocument: 'SAL-000001',
      actorId: fixture.userId,
    });

    expect(second).toMatchObject({ balanceBefore: 10, balanceAfter: 6 });
    const balance = await harness.prisma.stockBalance.findUnique({
      where: { productId_storeId: { productId: fixture.productId, storeId: fixture.storeId } },
    });
    expect(balance?.quantity).toBe(6);
  });

  it('rejects a movement that would drive the balance negative and writes no row', async () => {
    await service.post({
      productId: fixture.productId,
      storeId: fixture.storeId,
      qtyChange: 3,
      type: 'OPENING',
      sourceDocument: 'OPENING',
      actorId: null,
    });

    await expect(
      service.post({
        productId: fixture.productId,
        storeId: fixture.storeId,
        qtyChange: -5,
        type: 'SALE',
        sourceDocument: 'SAL-000002',
        actorId: fixture.userId,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: INSUFFICIENT_STOCK_MESSAGE });

    // The balance is unchanged and no SALE movement was written: the whole post rolled back.
    const balance = await harness.prisma.stockBalance.findUnique({
      where: { productId_storeId: { productId: fixture.productId, storeId: fixture.storeId } },
    });
    expect(balance?.quantity).toBe(3);
    const sales = await harness.prisma.stockMovement.findMany({
      where: { productId: fixture.productId, type: 'SALE' },
    });
    expect(sales).toHaveLength(0);
  });

  it('flips the product SKU lock the first time a movement references it', async () => {
    await service.post({
      productId: fixture.productId,
      storeId: fixture.storeId,
      qtyChange: 1,
      type: 'OPENING',
      sourceDocument: 'OPENING',
      actorId: null,
    });

    const product = await harness.prisma.product.findUnique({ where: { id: fixture.productId } });
    expect(product?.skuLocked).toBe(true);
  });

  it('allocates sequential document numbers for a prefix', async () => {
    const prefix = `IT${Date.now()}`;
    const first = await service.allocateDocumentNumber(prefix);
    const second = await service.allocateDocumentNumber(prefix);

    expect(first).toBe(`${prefix}-000001`);
    expect(second).toBe(`${prefix}-000002`);
  });

  it('rejects a duplicate document number at the database', async () => {
    const number = `DUP${Date.now()}-000001`;
    await harness.prisma.issuedDocumentNumber.create({ data: { number, prefix: 'DUP' } });

    await expect(
      harness.prisma.issuedDocumentNumber.create({ data: { number, prefix: 'DUP' } }),
    ).rejects.toMatchObject({ code: 'P2002' });

    // Clean up this test's row (reset only clears the fixture-scoped ledger prefixes).
    await harness.prisma.issuedDocumentNumber.deleteMany({ where: { number } });
  });
});

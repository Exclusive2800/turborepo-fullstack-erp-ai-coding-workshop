import { call } from '@orpc/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../database/prisma.service.js';
import {
  createIntegrationHarness,
  type IntegrationHarness,
  isDatabaseReachable,
} from '../test/integration-harness.js';
import { StockController } from './stock.controller.js';
import { StockPostingService } from './stock-posting.service.js';

// Seam 2 (store-scope tightening): the stock read endpoints over a real Postgres. The single
// correctness point a mocked PrismaService cannot exhibit is that the store scope is derived from
// the authenticated principal and enforced in the query against real rows in two stores — a STAFF
// caller can never read another store's ledger through `GET /stock/movements` (or balances through
// `GET /stock`), whatever `storeId` the request names, while a cross-store MANAGER sees both. This
// closes the RPT-03 store-scope leak the code review found. Each scenario seeds its own stores and
// product with a unique suffix so it never collides with the Section 8 fixture or a parallel spec.
const databaseReachable = await isDatabaseReachable();

describe.skipIf(!databaseReachable)('StockController store scope (real Postgres)', () => {
  let harness: IntegrationHarness;
  let controller: StockController;

  const storeIds: string[] = [];
  const productIds: string[] = [];
  const userIds: string[] = [];

  /**
   * Seed two stores (A and B), one product with a balance in each store, a STAFF user pinned to
   * store A and a MANAGER, and a ledger movement in each store. Returns the ids and principals a
   * test needs to assert scope.
   */
  async function seedScopeScenario() {
    const s = `stock-scope-${randomUUID()}`;
    const storeA = await harness.prisma.store.create({ data: { code: `A-${s}`, name: `A ${s}` } });
    const storeB = await harness.prisma.store.create({ data: { code: `B-${s}`, name: `B ${s}` } });
    storeIds.push(storeA.id, storeB.id);
    const product = await harness.prisma.product.create({
      data: {
        sku: `SKU-${s}`,
        name: `${s} product`,
        category: 'Test',
        unit: 'unit',
        sellingPrice: '10.00',
      },
    });
    productIds.push(product.id);

    const staff = await harness.prisma.user.create({
      data: {
        email: `staff-${s}@erp.local`,
        name: `staff ${s}`,
        role: 'STAFF',
        assignedStoreId: storeA.id,
        passwordHash: 'x',
      },
    });
    const manager = await harness.prisma.user.create({
      data: { email: `mgr-${s}@erp.local`, name: `mgr ${s}`, role: 'MANAGER', passwordHash: 'x' },
    });
    userIds.push(staff.id, manager.id);

    // A balance and a ledger movement in each store, so a leak would surface as a store-B row.
    for (const storeId of [storeA.id, storeB.id]) {
      await harness.prisma.stockBalance.create({
        data: { productId: product.id, storeId, quantity: 10 },
      });
      await harness.prisma.stockMovement.create({
        data: {
          productId: product.id,
          storeId,
          qtyChange: 10,
          balanceBefore: 0,
          balanceAfter: 10,
          type: 'OPENING',
          sourceDocument: 'OPENING',
          actorId: null,
          createdAt: new Date('2026-01-15T03:00:00.000Z'),
        },
      });
    }

    const staffPrincipal = {
      id: staff.id,
      email: staff.email,
      name: staff.name,
      role: 'STAFF' as const,
      assignedStoreId: storeA.id,
    };
    const managerPrincipal = {
      id: manager.id,
      email: manager.email,
      name: manager.name,
      role: 'MANAGER' as const,
      assignedStoreId: null,
    };
    return {
      productId: product.id,
      storeAId: storeA.id,
      storeBId: storeB.id,
      staffPrincipal,
      managerPrincipal,
    };
  }

  beforeAll(async () => {
    harness = createIntegrationHarness();
    controller = new StockController(
      harness.prisma as unknown as PrismaService,
      new StockPostingService(harness.prisma as unknown as PrismaService),
    );
  });

  afterAll(async () => {
    if (!harness) return;
    await harness.prisma.stockMovement.deleteMany({ where: { storeId: { in: storeIds } } });
    await harness.prisma.stockBalance.deleteMany({ where: { storeId: { in: storeIds } } });
    await harness.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await harness.prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await harness.prisma.store.deleteMany({ where: { id: { in: storeIds } } });
    await harness.close();
  });

  // The core authz proof: a STAFF caller pinned to store A asks for store B's ledger and gets only
  // store A's rows — the leak the review found is closed at the query, over real rows.
  it('never lets a STAFF caller read another store’s ledger through GET /stock/movements', async () => {
    const { productId, storeAId, storeBId, staffPrincipal, managerPrincipal } =
      await seedScopeScenario();

    // The STAFF caller explicitly names store B, but is pinned to store A.
    const asStaff = await call(controller.movements(staffPrincipal), {
      page: 1,
      pageSize: 50,
      productId,
      storeId: storeBId,
    });
    expect(asStaff.items.every((row) => row.storeId === storeAId)).toBe(true);
    expect(asStaff.items.some((row) => row.storeId === storeBId)).toBe(false);

    // A MANAGER naming no store sees both stores' movements for the product.
    const asManager = await call(controller.movements(managerPrincipal), {
      page: 1,
      pageSize: 50,
      productId,
    });
    const managerStores = new Set(asManager.items.map((row) => row.storeId));
    expect(managerStores.has(storeAId)).toBe(true);
    expect(managerStores.has(storeBId)).toBe(true);
  });

  // The same scope applies to the balance read: a STAFF caller asking for store B sees only store A.
  it('never lets a STAFF caller read another store’s balances through GET /stock', async () => {
    const { storeAId, storeBId, staffPrincipal } = await seedScopeScenario();

    const asStaff = await call(controller.search(staffPrincipal), {
      page: 1,
      pageSize: 50,
      storeId: storeBId,
    });
    expect(asStaff.items.every((row) => row.storeId === storeAId)).toBe(true);
    expect(asStaff.items.some((row) => row.storeId === storeBId)).toBe(false);
  });
});

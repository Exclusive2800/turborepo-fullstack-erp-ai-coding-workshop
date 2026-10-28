import { createPrismaClient, hashPassword, Role } from '../src/index.js';

const prisma = createPrismaClient(
  process.env.DATABASE_URL ?? 'postgresql://erp:erp@localhost:5432/erp',
);

// TOR Section 8 fixture. Re-running the seed resets these to a known clean state.
const stores = [
  { code: 'B01', name: 'Central' },
  { code: 'B02', name: 'Riverside' },
];

const suppliers = [
  {
    code: 'SUP01',
    name: 'SupplyOne',
    contactName: 'Somchai Prasert',
    contactEmail: 'somchai@supplyone.co.th',
    contactPhone: '02-123-4567',
  },
];

// TOR Section 8 products: three SKUs with their selling prices. Every product gets a reorder
// threshold of 3 in each store. B01 opening stock balances are written through the ledger (#5);
// B02 opens at zero. PO-DEMO-001 belongs to a later ticket.
const products = [
  {
    sku: 'SKU001',
    name: 'Drinking water pack of 6',
    category: 'Beverages',
    unit: 'pack',
    sellingPrice: '60.00',
  },
  {
    sku: 'SKU002',
    name: 'Tissue paper',
    category: 'Household',
    unit: 'pack',
    sellingPrice: '35.00',
  },
  {
    sku: 'SKU003',
    name: 'Laundry detergent',
    category: 'Household',
    unit: 'bag',
    sellingPrice: '120.00',
  },
];
const REORDER_THRESHOLD = 3;

// B01 opening stock balances (TOR Section 8, AC-08). SKU003 opens at 0 which is ≤ threshold 3, so
// it is the low-stock case the demo shows. B02 opens at zero for every SKU.
const B01_OPENING = { SKU001: 10, SKU002: 5, SKU003: 0 } as const;

// The four-role model (TOR Section 2). STAFF is pinned to a store; the rest are cross-store.
const DEMO_PASSWORD = 'password';
const demoUsers = [
  { email: 'admin@erp.local', name: 'Admin User', role: Role.ADMIN, storeCode: null },
  { email: 'buyer01@erp.local', name: 'Buyer One', role: Role.PURCHASING, storeCode: null },
  { email: 'manager01@erp.local', name: 'Manager One', role: Role.MANAGER, storeCode: null },
  { email: 'staff_b01@erp.local', name: 'Staff B01', role: Role.STAFF, storeCode: 'B01' },
  { email: 'staff_b02@erp.local', name: 'Staff B02', role: Role.STAFF, storeCode: 'B02' },
];

async function main() {
  const storeByCode = new Map<string, string>();
  for (const store of stores) {
    const row = await prisma.store.upsert({
      where: { code: store.code },
      update: { name: store.name },
      create: store,
    });
    storeByCode.set(store.code, row.id);
  }

  for (const supplier of suppliers) {
    await prisma.supplier.upsert({
      where: { code: supplier.code },
      update: {
        name: supplier.name,
        contactName: supplier.contactName,
        contactEmail: supplier.contactEmail,
        contactPhone: supplier.contactPhone,
      },
      create: supplier,
    });
  }

  // Products with a reorder threshold of 3 in every store (TOR Section 8). Reset the thresholds
  // to exactly the fixture on each run so the per-store set matches a fresh seed.
  const storeIds = [...storeByCode.values()];
  const productIdBySku = new Map<string, string>();
  for (const product of products) {
    const row = await prisma.product.upsert({
      where: { sku: product.sku },
      update: {
        name: product.name,
        category: product.category,
        unit: product.unit,
        sellingPrice: product.sellingPrice,
      },
      create: {
        sku: product.sku,
        name: product.name,
        category: product.category,
        unit: product.unit,
        sellingPrice: product.sellingPrice,
      },
    });
    productIdBySku.set(product.sku, row.id);
    await prisma.productStoreThreshold.deleteMany({ where: { productId: row.id } });
    await prisma.productStoreThreshold.createMany({
      data: storeIds.map((storeId) => ({
        productId: row.id,
        storeId,
        threshold: REORDER_THRESHOLD,
      })),
    });
  }

  // Opening stock balances via the append-only ledger (#5, INV-02/03). Reset the fixture products'
  // ledger to exactly these OPENING movements on each run: wipe their movements and balances, then
  // post one OPENING movement per store. B01 uses the Section 8 opening quantities (SKU003 = 0 is
  // the low-stock case); B02 opens every SKU at zero. A balance is only written when the opening
  // quantity is above zero, so a zero opening leaves no balance row — it still shows as low stock
  // via the threshold once a movement is posted. We write a zero-balance row and a zero movement so
  // the demo's "SKU003 at balance 0 shows low-stock in B01" and "opening balances appear as ledger
  // movements" both hold.
  const b01Id = storeByCode.get('B01');
  const b02Id = storeByCode.get('B02');
  const openingByStore: { storeId: string | undefined; quantities: Record<string, number> }[] = [
    { storeId: b01Id, quantities: B01_OPENING },
    { storeId: b02Id, quantities: { SKU001: 0, SKU002: 0, SKU003: 0 } },
  ];
  const fixtureProductIds = [...productIdBySku.values()];
  await prisma.stockMovement.deleteMany({ where: { productId: { in: fixtureProductIds } } });
  await prisma.stockBalance.deleteMany({ where: { productId: { in: fixtureProductIds } } });
  for (const { storeId, quantities } of openingByStore) {
    if (!storeId) continue;
    for (const [sku, quantity] of Object.entries(quantities)) {
      const productId = productIdBySku.get(sku);
      if (!productId) continue;
      await prisma.stockBalance.create({ data: { productId, storeId, quantity } });
      await prisma.stockMovement.create({
        data: {
          productId,
          storeId,
          qtyChange: quantity,
          balanceBefore: 0,
          balanceAfter: quantity,
          type: 'OPENING',
          sourceDocument: 'OPENING',
          actorId: null,
        },
      });
    }
  }

  const passwordHash = await hashPassword(DEMO_PASSWORD);
  for (const user of demoUsers) {
    const assignedStoreId = user.storeCode ? (storeByCode.get(user.storeCode) ?? null) : null;
    await prisma.user.upsert({
      where: { email: user.email },
      update: { name: user.name, role: user.role, assignedStoreId, passwordHash },
      create: {
        email: user.email,
        name: user.name,
        role: user.role,
        assignedStoreId,
        passwordHash,
      },
    });
  }

  // Demo purchase order PO-DEMO-001 (TOR Section 8): 20× SKU001 @ 45.00, destination B01, no
  // receipts. The TOR fixture describes it as *Approved*, but the approval transition is owned by
  // the PO state machine (#8); #7 only ever writes DRAFT and users never set status directly. So we
  // seed it at DRAFT now and leave a TODO for #8 to flip it to APPROVED through a real transition
  // once the state machine lands — we do NOT fabricate the APPROVED state here. Idempotent: the row
  // is keyed by its unique document number and its single line is reset to the fixture each run.
  // TODO(#8): once the PO state machine exists, advance PO-DEMO-001 DRAFT → PENDING_APPROVAL →
  // APPROVED via valid transitions so the seed matches the TOR's "Approved PO-DEMO-001" fixture.
  const PO_DEMO_NUMBER = 'PO-DEMO-001';
  const sku001Id = productIdBySku.get('SKU001');
  const buyer = await prisma.user.findUnique({ where: { email: 'buyer01@erp.local' } });
  if (sku001Id && b01Id) {
    const sku001 = products.find((product) => product.sku === 'SKU001');
    const demoQuantity = 20;
    const demoUnitPrice = '45.00';
    const demoLineTotal = (demoQuantity * Number(demoUnitPrice)).toFixed(2);
    const existing = await prisma.purchaseOrder.findUnique({ where: { number: PO_DEMO_NUMBER } });
    if (existing) {
      await prisma.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: existing.id } });
      await prisma.purchaseOrder.update({
        where: { id: existing.id },
        data: {
          status: 'DRAFT',
          supplierId: (await prisma.supplier.findUniqueOrThrow({ where: { code: 'SUP01' } })).id,
          storeId: b01Id,
          expectedReceiptDate: new Date('2026-02-01T00:00:00.000Z'),
          total: demoLineTotal,
          createdById: buyer?.id ?? null,
          lines: {
            create: [
              {
                productId: sku001Id,
                sku: 'SKU001',
                productName: sku001?.name ?? 'SKU001',
                quantity: demoQuantity,
                unitPrice: demoUnitPrice,
                lineTotal: demoLineTotal,
              },
            ],
          },
        },
      });
    } else {
      await prisma.purchaseOrder.create({
        data: {
          number: PO_DEMO_NUMBER,
          status: 'DRAFT',
          supplierId: (await prisma.supplier.findUniqueOrThrow({ where: { code: 'SUP01' } })).id,
          storeId: b01Id,
          expectedReceiptDate: new Date('2026-02-01T00:00:00.000Z'),
          total: demoLineTotal,
          createdById: buyer?.id ?? null,
          lines: {
            create: [
              {
                productId: sku001Id,
                sku: 'SKU001',
                productName: sku001?.name ?? 'SKU001',
                quantity: demoQuantity,
                unitPrice: demoUnitPrice,
                lineTotal: demoLineTotal,
              },
            ],
          },
        },
      });
    }
  }

  // Reset to exactly the fixture: drop anything left over from an earlier seed or from tests that
  // created data through the live API (the e2e suite adds stores/products/orders), so a reseed over
  // a used database matches a fresh one. Order matters: StockMovement/StockBalance,
  // PurchaseOrder(Line) and the master rows are linked by Restrict/relation foreign keys, so the
  // dependent rows for a non-fixture store or product must go before the master row they reference.
  const fixtureStoreCodes = stores.map((store) => store.code);
  const fixtureProductSkus = products.map((product) => product.sku);
  const nonFixtureStores = await prisma.store.findMany({
    where: { code: { notIn: fixtureStoreCodes } },
    select: { id: true },
  });
  const nonFixtureProducts = await prisma.product.findMany({
    where: { sku: { notIn: fixtureProductSkus } },
    select: { id: true },
  });
  const staleStoreIds = nonFixtureStores.map((store) => store.id);
  const staleProductIds = nonFixtureProducts.map((product) => product.id);

  // Purchase orders first (they reference supplier/store/product); PO-DEMO-001 is kept, everything
  // else — including any order that points at a store/product we are about to drop — goes. Lines
  // cascade from the order.
  await prisma.purchaseOrder.deleteMany({ where: { number: { notIn: [PO_DEMO_NUMBER] } } });

  // Sales are not part of the Section 8 fixture, so drop every sale (its lines cascade). This also
  // clears the SaleLine rows that reference a product we are about to delete, which would otherwise
  // block the product delete below on the SaleLine_productId foreign key.
  await prisma.sale.deleteMany({});

  // Ledger rows that reference a store or product we are about to drop. The fixture products' own
  // movements/balances were already reset above; this clears the rows tests created elsewhere so
  // the Restrict foreign keys don't block the master-row deletes below.
  if (staleStoreIds.length > 0 || staleProductIds.length > 0) {
    const staleRefFilter = {
      OR: [
        ...(staleStoreIds.length > 0 ? [{ storeId: { in: staleStoreIds } }] : []),
        ...(staleProductIds.length > 0 ? [{ productId: { in: staleProductIds } }] : []),
      ],
    };
    await prisma.stockMovement.deleteMany({ where: staleRefFilter });
    await prisma.stockBalance.deleteMany({ where: staleRefFilter });
  }

  // Now the master rows. Users first (an assignedStore FK points at Store).
  await prisma.user.deleteMany({
    where: { email: { notIn: demoUsers.map((user) => user.email) } },
  });
  await prisma.store.deleteMany({ where: { code: { notIn: fixtureStoreCodes } } });
  await prisma.supplier.deleteMany({
    where: { code: { notIn: suppliers.map((supplier) => supplier.code) } },
  });
  await prisma.product.deleteMany({ where: { sku: { notIn: fixtureProductSkus } } });

  console.log(
    `Seeded ${stores.length} stores, ${suppliers.length} suppliers, ${products.length} products (B01 opening stock via the ledger: SKU001=${B01_OPENING.SKU001}, SKU002=${B01_OPENING.SKU002}, SKU003=${B01_OPENING.SKU003}; B02 all zero) and ${demoUsers.length} demo users (password: "${DEMO_PASSWORD}").`,
  );
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}

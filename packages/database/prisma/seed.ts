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

  // Reset to exactly the fixture: drop any account, store or supplier left over from an earlier
  // seed, so a reseed over an existing database matches a fresh one.
  await prisma.user.deleteMany({
    where: { email: { notIn: demoUsers.map((user) => user.email) } },
  });
  await prisma.store.deleteMany({ where: { code: { notIn: stores.map((store) => store.code) } } });
  await prisma.supplier.deleteMany({
    where: { code: { notIn: suppliers.map((supplier) => supplier.code) } },
  });
  await prisma.product.deleteMany({
    where: { sku: { notIn: products.map((product) => product.sku) } },
  });

  console.log(
    `Seeded ${stores.length} stores, ${suppliers.length} suppliers, ${products.length} products (B01 opening stock via the ledger: SKU001=${B01_OPENING.SKU001}, SKU002=${B01_OPENING.SKU002}, SKU003=${B01_OPENING.SKU003}; B02 all zero) and ${demoUsers.length} demo users (password: "${DEMO_PASSWORD}").`,
  );
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}

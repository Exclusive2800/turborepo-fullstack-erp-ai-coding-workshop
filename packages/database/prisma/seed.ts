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
// threshold of 3 in each store. Opening stock balances and PO-DEMO-001 belong to a later ticket.
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
    await prisma.productStoreThreshold.deleteMany({ where: { productId: row.id } });
    await prisma.productStoreThreshold.createMany({
      data: storeIds.map((storeId) => ({
        productId: row.id,
        storeId,
        threshold: REORDER_THRESHOLD,
      })),
    });
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
    `Seeded ${stores.length} stores, ${suppliers.length} suppliers, ${products.length} products and ${demoUsers.length} demo users (password: "${DEMO_PASSWORD}").`,
  );
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}

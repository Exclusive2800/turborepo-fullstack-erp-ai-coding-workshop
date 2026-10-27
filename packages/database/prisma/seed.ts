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

  console.log(
    `Seeded ${stores.length} stores, ${suppliers.length} suppliers and ${demoUsers.length} demo users (password: "${DEMO_PASSWORD}").`,
  );
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}

import { createPrismaClient, hashPassword, Role } from '../src/index.js';

const prisma = createPrismaClient(
  process.env.DATABASE_URL ?? 'postgresql://erp:erp@localhost:5432/erp',
);

// TOR Section 8 fixture. Re-running the seed resets these to a known clean state.
const stores = [
  { code: 'B01', name: 'Central' },
  { code: 'B02', name: 'Riverside' },
];

// The four-role model (TOR Section 2). STAFF is pinned to a store; the rest are cross-store.
const demoUsers = [
  { email: 'admin@erp.local', name: 'Admin User', role: Role.ADMIN, storeCode: null },
  { email: 'buyer01@erp.local', name: 'Buyer One', role: Role.PURCHASING, storeCode: null },
  { email: 'manager01@erp.local', name: 'Manager One', role: Role.MANAGER, storeCode: null },
  { email: 'staff_b01@erp.local', name: 'Staff B01', role: Role.STAFF, storeCode: 'B01' },
  { email: 'staff_b02@erp.local', name: 'Staff B02', role: Role.STAFF, storeCode: 'B02' },
];
const DEMO_PASSWORD = 'password';

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

  console.log(
    `Seeded ${stores.length} stores and ${demoUsers.length} demo users (password: "${DEMO_PASSWORD}").`,
  );
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}

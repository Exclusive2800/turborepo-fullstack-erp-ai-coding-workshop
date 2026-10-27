import path from 'node:path';

// Demo accounts from packages/database/prisma/seed.ts. Tests never create users;
// they sign in as one of these through the saved storage state. `staff` is a store
// employee pinned to store B01.
export const DEMO_PASSWORD = 'password';

export const accounts = {
  admin: { email: 'admin@erp.local', name: 'Admin User', role: 'ADMIN' },
  manager: { email: 'manager01@erp.local', name: 'Manager One', role: 'MANAGER' },
  staff: { email: 'staff_b01@erp.local', name: 'Staff B01', role: 'STAFF' },
} as const;

export type AccountName = keyof typeof accounts;

/** Where auth.setup.ts saves each account's cookies. Gitignored. */
export function storageState(name: AccountName) {
  return path.resolve(import.meta.dirname, '..', '.auth', `${name}.json`);
}

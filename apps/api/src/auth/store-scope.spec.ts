import { ORPCError } from '@orpc/server';
import type { User } from '@erp/contracts';
import { describe, expect, it } from 'vitest';
import { assertStoreScope, type StoreScopedUser } from './store-scope.js';

const staffB01: StoreScopedUser = {
  id: 'u1',
  email: 'staff_b01@erp.local',
  name: 'Staff B01',
  role: 'STAFF',
  assignedStoreId: 'store-b01',
};
const manager: StoreScopedUser = {
  id: 'u2',
  email: 'manager@erp.local',
  name: 'Manager',
  role: 'MANAGER',
  assignedStoreId: null,
};
const admin: StoreScopedUser = { ...manager, role: 'ADMIN', email: 'admin@erp.local' };

describe('assertStoreScope', () => {
  it('lets a manager act for any store', () => {
    expect(() => assertStoreScope(manager, 'store-b01')).not.toThrow();
    expect(() => assertStoreScope(manager, 'store-b02')).not.toThrow();
  });

  it('lets an admin act for any store', () => {
    expect(() => assertStoreScope(admin, 'store-b02')).not.toThrow();
  });

  it('lets a staff user act only for their assigned store', () => {
    expect(() => assertStoreScope(staffB01, 'store-b01')).not.toThrow();
  });

  it('rejects a staff user acting for another store', () => {
    expect(() => assertStoreScope(staffB01, 'store-b02')).toThrow(ORPCError);
    try {
      assertStoreScope(staffB01, 'store-b02');
    } catch (error) {
      expect(error).toBeInstanceOf(ORPCError);
      expect((error as ORPCError<string, unknown>).code).toBe('FORBIDDEN');
    }
  });

  it('rejects a staff user with no assigned store', () => {
    expect(() => assertStoreScope({ ...staffB01, assignedStoreId: null }, 'store-b01')).toThrow(
      ORPCError,
    );
  });
});

describe('resolveStoreScope', () => {
  it('ignores a store from the request body and derives it from the staff principal', async () => {
    const { resolveStoreScope } = await import('./store-scope.js');
    // A staff user's effective store is always their assignment, whatever the body claims.
    expect(resolveStoreScope(staffB01, 'store-b02')).toBe('store-b01');
  });

  it('uses the requested store for a cross-store principal', async () => {
    const { resolveStoreScope } = await import('./store-scope.js');
    expect(resolveStoreScope(manager, 'store-b02')).toBe('store-b02');
  });

  it('requires a target store for a cross-store principal', async () => {
    const { resolveStoreScope } = await import('./store-scope.js');
    expect(() => resolveStoreScope(manager, undefined)).toThrow(ORPCError);
  });
});

// Keep the User type referenced so the helper's input stays assignable from the contract shape.
const _typecheck: User = staffB01;
void _typecheck;

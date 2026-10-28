import type { Whoami } from '@erp/contracts';
import { ORPCError } from '@orpc/nest';
import { describe, expect, it } from 'vitest';
import { assertStoreScope, resolveReadStoreScope, resolveStoreScope } from './store-scope.js';

const staffB01: Whoami = {
  id: 'u1',
  email: 'staff_b01@erp.local',
  name: 'Staff B01',
  role: 'STAFF',
  assignedStoreId: 'store-b01',
};
const manager: Whoami = {
  id: 'u2',
  email: 'manager@erp.local',
  name: 'Manager',
  role: 'MANAGER',
  assignedStoreId: null,
};
const admin: Whoami = { ...manager, role: 'ADMIN', email: 'admin@erp.local' };

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
    try {
      assertStoreScope(staffB01, 'store-b02');
      expect.unreachable('expected a FORBIDDEN rejection');
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
  it('ignores a store from the request body and derives it from the staff principal', () => {
    // A staff user's effective store is always their assignment, whatever the body claims.
    expect(resolveStoreScope(staffB01, 'store-b02')).toBe('store-b01');
  });

  it('uses the requested store for a cross-store principal', () => {
    expect(resolveStoreScope(manager, 'store-b02')).toBe('store-b02');
  });

  it('requires a target store for a cross-store principal', () => {
    expect(() => resolveStoreScope(manager, undefined)).toThrow(ORPCError);
  });
});

describe('resolveReadStoreScope', () => {
  it('pins a staff reader to their assigned store, ignoring the requested store', () => {
    // Whatever the body claims, a staff reader only ever sees their own store.
    expect(resolveReadStoreScope(staffB01, 'store-b02')).toBe('store-b01');
    expect(resolveReadStoreScope(staffB01, undefined)).toBe('store-b01');
  });

  it('rejects a staff reader with no assigned store', () => {
    try {
      resolveReadStoreScope({ ...staffB01, assignedStoreId: null }, undefined);
      expect.unreachable('expected a FORBIDDEN rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ORPCError);
      expect((error as ORPCError<string, unknown>).code).toBe('FORBIDDEN');
    }
  });

  it('lets a cross-store reader see every store when none is named (null)', () => {
    // Role = what, store = where: a cross-store role with no store named reads every store.
    expect(resolveReadStoreScope(manager, undefined)).toBeNull();
    expect(resolveReadStoreScope(admin, undefined)).toBeNull();
  });

  it('scopes a cross-store reader to the one store they name', () => {
    expect(resolveReadStoreScope(manager, 'store-b02')).toBe('store-b02');
  });
});

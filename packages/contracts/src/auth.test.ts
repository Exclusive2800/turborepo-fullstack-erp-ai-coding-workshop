import { describe, expect, it } from 'vitest';
import { LoginInputSchema, RoleSchema, SessionSchema, WhoamiSchema } from './auth.js';

describe('RoleSchema', () => {
  it.each(['ADMIN', 'PURCHASING', 'STAFF', 'MANAGER'])('accepts the role %s', (role) => {
    expect(RoleSchema.safeParse(role).success).toBe(true);
  });

  it('rejects a role outside the four-role model', () => {
    expect(RoleSchema.safeParse('OWNER').success).toBe(false);
  });
});

describe('WhoamiSchema', () => {
  it('accepts a store-scoped principal with an assigned store', () => {
    const result = WhoamiSchema.safeParse({
      id: '1',
      email: 'staff@erp.local',
      name: 'Staff',
      role: 'STAFF',
      assignedStoreId: 'store-b01',
    });

    expect(result.success).toBe(true);
  });

  it('accepts a cross-store principal with a null assigned store', () => {
    const result = WhoamiSchema.safeParse({
      id: '1',
      email: 'manager@erp.local',
      name: 'Manager',
      role: 'MANAGER',
      assignedStoreId: null,
    });

    expect(result.success).toBe(true);
  });

  it('rejects a store-scoped STAFF principal with no assigned store', () => {
    const result = WhoamiSchema.safeParse({
      id: '1',
      email: 'staff@erp.local',
      name: 'Staff',
      role: 'STAFF',
      assignedStoreId: null,
    });

    expect(result.success).toBe(false);
  });

  it('rejects a cross-store principal pinned to a store', () => {
    const result = WhoamiSchema.safeParse({
      id: '1',
      email: 'manager@erp.local',
      name: 'Manager',
      role: 'MANAGER',
      assignedStoreId: 'store-b01',
    });

    expect(result.success).toBe(false);
  });
});

describe('LoginInputSchema', () => {
  it('accepts an email and password', () => {
    const result = LoginInputSchema.safeParse({ email: 'admin@erp.local', password: 'password' });

    expect(result.success).toBe(true);
  });

  it('rejects an invalid email', () => {
    const result = LoginInputSchema.safeParse({ email: 'admin', password: 'password' });

    expect(result.success).toBe(false);
  });

  it('rejects an empty password', () => {
    const result = LoginInputSchema.safeParse({ email: 'admin@erp.local', password: '' });

    expect(result.success).toBe(false);
  });
});

describe('SessionSchema', () => {
  it('accepts a signed-out session', () => {
    expect(SessionSchema.safeParse({ user: null }).success).toBe(true);
  });

  it('rejects an unknown role', () => {
    const result = SessionSchema.safeParse({
      user: { id: '1', email: 'a@erp.local', name: 'A', role: 'OWNER' },
    });

    expect(result.success).toBe(false);
  });
});

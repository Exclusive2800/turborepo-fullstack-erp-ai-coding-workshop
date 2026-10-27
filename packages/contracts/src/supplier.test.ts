import { describe, expect, it } from 'vitest';
import { SupplierCreateInputSchema } from './supplier.js';

describe('SupplierCreateInputSchema', () => {
  it('accepts a code and name without contact details', () => {
    const result = SupplierCreateInputSchema.safeParse({ code: 'SUP01', name: 'SupplyOne' });

    expect(result.success).toBe(true);
  });

  it('accepts full contact details', () => {
    const result = SupplierCreateInputSchema.safeParse({
      code: 'SUP01',
      name: 'SupplyOne',
      contactName: 'Somchai',
      contactEmail: 'somchai@supplyone.co.th',
      contactPhone: '02-123-4567',
    });

    expect(result.success).toBe(true);
  });

  it('rejects an empty code', () => {
    expect(SupplierCreateInputSchema.safeParse({ code: '', name: 'SupplyOne' }).success).toBe(
      false,
    );
  });

  it('rejects a malformed contact email', () => {
    const result = SupplierCreateInputSchema.safeParse({
      code: 'SUP01',
      name: 'SupplyOne',
      contactEmail: 'not-an-email',
    });

    expect(result.success).toBe(false);
  });

  it('allows an empty contact email string', () => {
    const result = SupplierCreateInputSchema.safeParse({
      code: 'SUP01',
      name: 'SupplyOne',
      contactEmail: '',
    });

    expect(result.success).toBe(true);
  });
});

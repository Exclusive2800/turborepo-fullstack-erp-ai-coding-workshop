import { describe, expect, it } from 'vitest';
import { StoreCreateInputSchema, StoreListSchema, StoreUpdateInputSchema } from './store.js';

describe('StoreCreateInputSchema', () => {
  it('accepts a code and name', () => {
    const result = StoreCreateInputSchema.safeParse({ code: 'B01', name: 'Central' });

    expect(result.success).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    const result = StoreCreateInputSchema.safeParse({ code: '  B01  ', name: '  Central  ' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ code: 'B01', name: 'Central' });
    }
  });

  it('rejects an empty code', () => {
    expect(StoreCreateInputSchema.safeParse({ code: '', name: 'Central' }).success).toBe(false);
  });

  it('rejects a blank name', () => {
    expect(StoreCreateInputSchema.safeParse({ code: 'B01', name: '   ' }).success).toBe(false);
  });
});

describe('StoreUpdateInputSchema', () => {
  it('requires an id', () => {
    expect(StoreUpdateInputSchema.safeParse({ code: 'B01', name: 'Central' }).success).toBe(false);
  });

  it('accepts an id with code and name', () => {
    const result = StoreUpdateInputSchema.safeParse({ id: 'abc', code: 'B01', name: 'Central' });

    expect(result.success).toBe(true);
  });
});

describe('StoreListSchema', () => {
  it('accepts a paginated envelope', () => {
    const result = StoreListSchema.safeParse({
      items: [
        {
          id: 'abc',
          code: 'B01',
          name: 'Central',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    expect(result.success).toBe(true);
  });
});

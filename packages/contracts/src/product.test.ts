import { describe, expect, it } from 'vitest';
import {
  ProductCreateInputSchema,
  ReorderThresholdInputSchema,
  StockQuantitySchema,
} from './product.js';

const base = {
  sku: 'SKU001',
  name: 'Drinking water pack of 6',
  category: 'Beverages',
  unit: 'pack',
  sellingPrice: 60,
};

describe('ProductCreateInputSchema', () => {
  it('accepts a product with no thresholds (defaults active and thresholds)', () => {
    const result = ProductCreateInputSchema.safeParse(base);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.active).toBe(true);
      expect(result.data.thresholds).toEqual([]);
    }
  });

  it('accepts per-store reorder thresholds', () => {
    const result = ProductCreateInputSchema.safeParse({
      ...base,
      thresholds: [{ storeId: 'store1', threshold: 3 }],
    });

    expect(result.success).toBe(true);
  });

  it('rejects an empty SKU', () => {
    expect(ProductCreateInputSchema.safeParse({ ...base, sku: '' }).success).toBe(false);
  });

  it('rejects a negative selling price', () => {
    const result = ProductCreateInputSchema.safeParse({ ...base, sellingPrice: -1 });

    expect(result.success).toBe(false);
  });

  it('rejects a negative reorder threshold', () => {
    const result = ProductCreateInputSchema.safeParse({
      ...base,
      thresholds: [{ storeId: 'store1', threshold: -1 }],
    });

    expect(result.success).toBe(false);
  });

  it('rejects a non-integer reorder threshold', () => {
    const result = ReorderThresholdInputSchema.safeParse({ storeId: 'store1', threshold: 2.5 });

    expect(result.success).toBe(false);
  });
});

describe('StockQuantitySchema', () => {
  it('accepts a whole, non-negative quantity', () => {
    expect(StockQuantitySchema.safeParse(10).success).toBe(true);
    expect(StockQuantitySchema.safeParse(0).success).toBe(true);
  });

  it('rejects a non-integer quantity', () => {
    expect(StockQuantitySchema.safeParse(2.5).success).toBe(false);
  });

  it('rejects a negative quantity', () => {
    expect(StockQuantitySchema.safeParse(-3).success).toBe(false);
  });
});

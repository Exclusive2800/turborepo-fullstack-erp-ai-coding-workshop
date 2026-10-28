import { describe, expect, it } from 'vitest';
import { ADJUSTMENT_REASON_REQUIRED_MESSAGE } from './errors.js';
import {
  StockAdjustInputSchema,
  StockItemSchema,
  StockMovementListInputSchema,
  StockMovementSchema,
  StockMovementTypeSchema,
  StockSearchInputSchema,
  StockSearchResultSchema,
} from './stock.js';

describe('StockMovementTypeSchema', () => {
  it('accepts every movement kind this release emits', () => {
    for (const type of ['OPENING', 'ADJUSTMENT', 'GOODS_RECEIPT', 'SALE']) {
      expect(StockMovementTypeSchema.safeParse(type).success).toBe(true);
    }
  });

  it('rejects an unknown movement kind', () => {
    expect(StockMovementTypeSchema.safeParse('TRANSFER').success).toBe(false);
  });
});

describe('StockSearchInputSchema', () => {
  it('defaults pagination and allows an empty search', () => {
    const result = StockSearchInputSchema.safeParse({});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ page: 1, pageSize: 20 });
    }
  });

  it('accepts a query and a store filter', () => {
    const result = StockSearchInputSchema.safeParse({ query: 'SKU001', storeId: 's1' });

    expect(result.success).toBe(true);
  });

  it('coerces string pagination from the query string', () => {
    const result = StockSearchInputSchema.safeParse({ page: '2', pageSize: '50' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toMatchObject({ page: 2, pageSize: 50 });
    }
  });
});

describe('StockItemSchema', () => {
  const item = {
    productId: 'p1',
    sku: 'SKU001',
    name: 'Drinking water pack of 6',
    unit: 'pack',
    storeId: 's1',
    storeCode: 'B01',
    quantity: 10,
    reorderThreshold: 3,
    lowStock: false,
  };

  it('accepts a stock row with a threshold', () => {
    expect(StockItemSchema.safeParse(item).success).toBe(true);
  });

  it('accepts a null reorder threshold', () => {
    expect(StockItemSchema.safeParse({ ...item, reorderThreshold: null }).success).toBe(true);
  });

  it('rejects a negative quantity', () => {
    expect(StockItemSchema.safeParse({ ...item, quantity: -1 }).success).toBe(false);
  });

  it('rejects a fractional quantity', () => {
    expect(StockItemSchema.safeParse({ ...item, quantity: 1.5 }).success).toBe(false);
  });
});

describe('StockSearchResultSchema', () => {
  it('accepts a paginated envelope of stock rows', () => {
    const result = StockSearchResultSchema.safeParse({
      items: [
        {
          productId: 'p1',
          sku: 'SKU003',
          name: 'Laundry detergent',
          unit: 'bag',
          storeId: 's1',
          storeCode: 'B01',
          quantity: 0,
          reorderThreshold: 3,
          lowStock: true,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });

    expect(result.success).toBe(true);
  });
});

describe('StockMovementSchema', () => {
  const movement = {
    id: 'm1',
    productId: 'p1',
    storeId: 's1',
    qtyChange: 10,
    balanceBefore: 0,
    balanceAfter: 10,
    type: 'OPENING',
    sourceDocument: 'OPENING',
    reason: null,
    actorId: null,
    createdAt: new Date().toISOString(),
  };

  it('accepts an opening movement with a null actor', () => {
    expect(StockMovementSchema.safeParse(movement).success).toBe(true);
  });

  it('accepts a negative quantity change for a sale', () => {
    expect(
      StockMovementSchema.safeParse({
        ...movement,
        qtyChange: -2,
        balanceBefore: 10,
        balanceAfter: 8,
        type: 'SALE',
        sourceDocument: 'SAL-000001',
        actorId: 'u1',
      }).success,
    ).toBe(true);
  });

  it('accepts an adjustment movement carrying a reason', () => {
    expect(
      StockMovementSchema.safeParse({
        ...movement,
        type: 'ADJUSTMENT',
        sourceDocument: 'ADJUSTMENT',
        reason: 'นับสต็อกใหม่พบว่าของจริงมากกว่าในระบบ',
        actorId: 'u1',
      }).success,
    ).toBe(true);
  });

  it('rejects a negative resulting balance', () => {
    expect(StockMovementSchema.safeParse({ ...movement, balanceAfter: -1 }).success).toBe(false);
  });
});

describe('StockMovementListInputSchema', () => {
  it('accepts product, store and type filters', () => {
    const result = StockMovementListInputSchema.safeParse({
      productId: 'p1',
      storeId: 's1',
      type: 'SALE',
    });

    expect(result.success).toBe(true);
  });

  it('rejects an unknown movement type filter', () => {
    expect(StockMovementListInputSchema.safeParse({ type: 'TRANSFER' }).success).toBe(false);
  });
});

describe('StockAdjustInputSchema', () => {
  const input = { productId: 'p1', storeId: 's1', qtyChange: 5, reason: 'นับสต็อกใหม่' };

  it('accepts an increase with a reason', () => {
    expect(StockAdjustInputSchema.safeParse(input).success).toBe(true);
  });

  it('accepts a decrease with a reason', () => {
    expect(StockAdjustInputSchema.safeParse({ ...input, qtyChange: -3 }).success).toBe(true);
  });

  it('rejects a missing reason', () => {
    const result = StockAdjustInputSchema.safeParse({
      productId: 'p1',
      storeId: 's1',
      qtyChange: 5,
    });
    expect(result.success).toBe(false);
  });

  it('gives the actionable Thai message when the reason is missing or blank', () => {
    const omitted = StockAdjustInputSchema.safeParse({
      productId: 'p1',
      storeId: 's1',
      qtyChange: 5,
    });
    const blank = StockAdjustInputSchema.safeParse({ ...input, reason: '   ' });
    for (const result of [omitted, blank]) {
      expect(result.success).toBe(false);
      if (!result.success) {
        const reasonIssue = result.error.issues.find((issue) => issue.path[0] === 'reason');
        expect(reasonIssue?.message).toBe(ADJUSTMENT_REASON_REQUIRED_MESSAGE);
      }
    }
  });

  it('rejects a blank, whitespace-only reason', () => {
    const result = StockAdjustInputSchema.safeParse({ ...input, reason: '   ' });
    expect(result.success).toBe(false);
  });

  it('rejects a zero quantity change', () => {
    expect(StockAdjustInputSchema.safeParse({ ...input, qtyChange: 0 }).success).toBe(false);
  });

  it('rejects a fractional quantity change', () => {
    expect(StockAdjustInputSchema.safeParse({ ...input, qtyChange: 1.5 }).success).toBe(false);
  });

  it('trims the reason', () => {
    const result = StockAdjustInputSchema.safeParse({ ...input, reason: '  นับสต็อกใหม่  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.reason).toBe('นับสต็อกใหม่');
  });
});

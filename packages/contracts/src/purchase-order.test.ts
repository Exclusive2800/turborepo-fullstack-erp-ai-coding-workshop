import { describe, expect, it } from 'vitest';
import {
  PO_DUPLICATE_SKU_MESSAGE,
  PO_LINES_REQUIRED_MESSAGE,
  PO_QUANTITY_POSITIVE_MESSAGE,
  PO_UNIT_PRICE_NONNEGATIVE_MESSAGE,
} from './errors.js';
import {
  PurchaseOrderCreateInputSchema,
  PurchaseOrderLineInputSchema,
  PurchaseOrderSchema,
  PurchaseOrderStatusSchema,
} from './purchase-order.js';

describe('PurchaseOrderStatusSchema', () => {
  it('accepts every status in the full lifecycle', () => {
    for (const status of [
      'DRAFT',
      'PENDING_APPROVAL',
      'APPROVED',
      'PARTIALLY_RECEIVED',
      'COMPLETED',
      'REJECTED',
      'CANCELLED',
    ]) {
      expect(PurchaseOrderStatusSchema.safeParse(status).success).toBe(true);
    }
  });

  it('rejects an unknown status', () => {
    expect(PurchaseOrderStatusSchema.safeParse('SHIPPED').success).toBe(false);
  });
});

describe('PurchaseOrderLineInputSchema', () => {
  const line = { productId: 'p1', quantity: 20, unitPrice: 45 };

  it('accepts a positive whole quantity and a non-negative price', () => {
    expect(PurchaseOrderLineInputSchema.safeParse(line).success).toBe(true);
  });

  it('accepts a zero unit price (free line)', () => {
    expect(PurchaseOrderLineInputSchema.safeParse({ ...line, unitPrice: 0 }).success).toBe(true);
  });

  it('rejects a zero quantity with the actionable Thai message', () => {
    const result = PurchaseOrderLineInputSchema.safeParse({ ...line, quantity: 0 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(PO_QUANTITY_POSITIVE_MESSAGE);
    }
  });

  it('rejects a fractional quantity with the actionable Thai message', () => {
    const result = PurchaseOrderLineInputSchema.safeParse({ ...line, quantity: 2.5 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(PO_QUANTITY_POSITIVE_MESSAGE);
    }
  });

  it('rejects a negative quantity', () => {
    expect(PurchaseOrderLineInputSchema.safeParse({ ...line, quantity: -1 }).success).toBe(false);
  });

  it('rejects a negative unit price with the actionable Thai message', () => {
    const result = PurchaseOrderLineInputSchema.safeParse({ ...line, unitPrice: -0.01 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(PO_UNIT_PRICE_NONNEGATIVE_MESSAGE);
    }
  });
});

describe('PurchaseOrderCreateInputSchema', () => {
  const base = {
    supplierId: 'sup1',
    storeId: 's1',
    expectedReceiptDate: '2026-02-01T00:00:00.000Z',
    lines: [
      { productId: 'p1', quantity: 20, unitPrice: 45 },
      { productId: 'p2', quantity: 5, unitPrice: 35 },
    ],
  };

  it('accepts a well-formed draft order with multiple distinct lines', () => {
    expect(PurchaseOrderCreateInputSchema.safeParse(base).success).toBe(true);
  });

  it('rejects an order with no lines with the actionable Thai message', () => {
    const result = PurchaseOrderCreateInputSchema.safeParse({ ...base, lines: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      const linesIssue = result.error.issues.find((issue) => issue.path[0] === 'lines');
      expect(linesIssue?.message).toBe(PO_LINES_REQUIRED_MESSAGE);
    }
  });

  it('rejects a duplicate SKU (same product on two lines) with the actionable Thai message', () => {
    const result = PurchaseOrderCreateInputSchema.safeParse({
      ...base,
      lines: [
        { productId: 'p1', quantity: 20, unitPrice: 45 },
        { productId: 'p1', quantity: 1, unitPrice: 10 },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const duplicateIssue = result.error.issues.find(
        (issue) => issue.message === PO_DUPLICATE_SKU_MESSAGE,
      );
      expect(duplicateIssue).toBeDefined();
    }
  });

  it('rejects an order with a missing expected receipt date', () => {
    const { expectedReceiptDate: _omit, ...withoutDate } = base;
    expect(PurchaseOrderCreateInputSchema.safeParse(withoutDate).success).toBe(false);
  });

  it('does not accept a status field (status is never client-set)', () => {
    const result = PurchaseOrderCreateInputSchema.safeParse({ ...base, status: 'APPROVED' });
    // The extra key is stripped; the parsed value never carries a client-supplied status.
    expect(result.success).toBe(true);
    if (result.success) {
      expect('status' in result.data).toBe(false);
    }
  });
});

describe('PurchaseOrderSchema', () => {
  const order = {
    id: 'po1',
    number: 'PO-000001',
    status: 'DRAFT',
    supplierId: 'sup1',
    storeId: 's1',
    expectedReceiptDate: '2026-02-01T00:00:00.000Z',
    total: '975.00',
    lines: [
      {
        id: 'l1',
        productId: 'p1',
        sku: 'SKU001',
        productName: 'Drinking water pack of 6',
        quantity: 20,
        unitPrice: '45.00',
        lineTotal: '900.00',
      },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('accepts a draft order with a snapshot line and money strings', () => {
    expect(PurchaseOrderSchema.safeParse(order).success).toBe(true);
  });

  it('rejects a line with a non-integer quantity', () => {
    const result = PurchaseOrderSchema.safeParse({
      ...order,
      lines: [{ ...order.lines[0], quantity: 1.5 }],
    });
    expect(result.success).toBe(false);
  });
});

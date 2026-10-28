import { describe, expect, it } from 'vitest';
import {
  SALE_DUPLICATE_PRODUCT_MESSAGE,
  SALE_LINES_REQUIRED_MESSAGE,
  SALE_QUANTITY_POSITIVE_MESSAGE,
} from './errors.js';
import {
  SaleConfirmInputSchema,
  SaleCreateInputSchema,
  SaleLineInputSchema,
  SaleSchema,
  SaleStatusSchema,
} from './sale.js';

describe('SaleStatusSchema', () => {
  it('accepts the two lifecycle statuses', () => {
    expect(SaleStatusSchema.safeParse('DRAFT').success).toBe(true);
    expect(SaleStatusSchema.safeParse('CONFIRMED').success).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(SaleStatusSchema.safeParse('VOID').success).toBe(false);
  });
});

describe('SaleLineInputSchema', () => {
  const line = { productId: 'p1', quantity: 2 };

  it('accepts a positive whole quantity', () => {
    expect(SaleLineInputSchema.safeParse(line).success).toBe(true);
  });

  it('rejects a zero quantity with the actionable Thai message', () => {
    const result = SaleLineInputSchema.safeParse({ ...line, quantity: 0 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(SALE_QUANTITY_POSITIVE_MESSAGE);
    }
  });

  it('rejects a fractional quantity with the actionable Thai message', () => {
    const result = SaleLineInputSchema.safeParse({ ...line, quantity: 2.5 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(SALE_QUANTITY_POSITIVE_MESSAGE);
    }
  });

  it('rejects a negative quantity', () => {
    expect(SaleLineInputSchema.safeParse({ ...line, quantity: -1 }).success).toBe(false);
  });

  it('ignores any client-supplied unit price (controlled pricing, SAL-02)', () => {
    // A price sent by the client is stripped: the server reads the current selling price itself.
    const result = SaleLineInputSchema.safeParse({ ...line, unitPrice: 1 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('unitPrice' in result.data).toBe(false);
    }
  });
});

describe('SaleCreateInputSchema', () => {
  const base = {
    lines: [
      { productId: 'p1', quantity: 2 },
      { productId: 'p2', quantity: 3 },
    ],
  };

  it('accepts a well-formed draft sale with distinct lines', () => {
    expect(SaleCreateInputSchema.safeParse(base).success).toBe(true);
  });

  it('rejects a sale with no lines with the actionable Thai message', () => {
    const result = SaleCreateInputSchema.safeParse({ ...base, lines: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      const linesIssue = result.error.issues.find((issue) => issue.path[0] === 'lines');
      expect(linesIssue?.message).toBe(SALE_LINES_REQUIRED_MESSAGE);
    }
  });

  it('rejects a duplicate product on two lines with the actionable Thai message', () => {
    const result = SaleCreateInputSchema.safeParse({
      ...base,
      lines: [
        { productId: 'p1', quantity: 2 },
        { productId: 'p1', quantity: 1 },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const duplicateIssue = result.error.issues.find(
        (issue) => issue.message === SALE_DUPLICATE_PRODUCT_MESSAGE,
      );
      expect(duplicateIssue).toBeDefined();
    }
  });

  it('does not accept a status field (status is never client-set)', () => {
    const result = SaleCreateInputSchema.safeParse({ ...base, status: 'CONFIRMED' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('status' in result.data).toBe(false);
    }
  });

  it('does not accept a storeId field (store is derived from the principal, never the body)', () => {
    const result = SaleCreateInputSchema.safeParse({ ...base, storeId: 's-other' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('storeId' in result.data).toBe(false);
    }
  });
});

describe('SaleSchema', () => {
  const sale = {
    id: 'sale1',
    storeId: 's1',
    status: 'DRAFT',
    total: '155.00',
    documentNumber: null,
    confirmedAt: null,
    lines: [
      {
        id: 'l1',
        productId: 'p1',
        sku: 'SKU001',
        productName: 'Drinking water pack of 6',
        quantity: 2,
        unitPrice: '60.00',
        lineTotal: '120.00',
      },
      {
        id: 'l2',
        productId: 'p2',
        sku: 'SKU002',
        productName: 'Tissue paper',
        quantity: 1,
        unitPrice: '35.00',
        lineTotal: '35.00',
      },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('accepts a draft sale with snapshot lines and money strings', () => {
    expect(SaleSchema.safeParse(sale).success).toBe(true);
  });

  it('accepts a confirmed sale with a document number and confirmation timestamp', () => {
    const confirmed = {
      ...sale,
      status: 'CONFIRMED',
      documentNumber: 'SAL-000001',
      confirmedAt: '2026-01-02T03:04:05.000Z',
    };
    expect(SaleSchema.safeParse(confirmed).success).toBe(true);
  });

  it('rejects a line with a non-integer quantity', () => {
    const result = SaleSchema.safeParse({
      ...sale,
      lines: [{ ...sale.lines[0], quantity: 1.5 }],
    });
    expect(result.success).toBe(false);
  });
});

describe('SaleConfirmInputSchema', () => {
  it('accepts a sale id with no idempotency key', () => {
    expect(SaleConfirmInputSchema.safeParse({ id: 'sale1' }).success).toBe(true);
  });

  it('accepts a sale id with an idempotency key', () => {
    const result = SaleConfirmInputSchema.safeParse({ id: 'sale1', idempotencyKey: 'k-1' });
    expect(result.success).toBe(true);
  });

  it('rejects a missing sale id', () => {
    expect(SaleConfirmInputSchema.safeParse({ idempotencyKey: 'k-1' }).success).toBe(false);
  });

  it('rejects an empty idempotency key', () => {
    expect(SaleConfirmInputSchema.safeParse({ id: 'sale1', idempotencyKey: '' }).success).toBe(
      false,
    );
  });
});

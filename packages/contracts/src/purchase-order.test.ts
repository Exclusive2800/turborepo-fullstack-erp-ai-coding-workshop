import { describe, expect, it } from 'vitest';
import {
  PO_CANCEL_REASON_REQUIRED_MESSAGE,
  PO_DUPLICATE_SKU_MESSAGE,
  PO_LINES_REQUIRED_MESSAGE,
  PO_QUANTITY_POSITIVE_MESSAGE,
  PO_REJECT_REASON_REQUIRED_MESSAGE,
  PO_UNIT_PRICE_NONNEGATIVE_MESSAGE,
} from './errors.js';
import {
  findPurchaseOrderTransition,
  PO_TRANSITIONS,
  PurchaseOrderCancelInputSchema,
  PurchaseOrderCreateInputSchema,
  PurchaseOrderLineInputSchema,
  PurchaseOrderRejectInputSchema,
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
    statusReason: null,
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

  it('accepts a rejected order carrying its reason', () => {
    const result = PurchaseOrderSchema.safeParse({
      ...order,
      status: 'REJECTED',
      statusReason: 'ราคาสูงเกินไป',
    });
    expect(result.success).toBe(true);
  });
});

describe('PO_TRANSITIONS authoritative table', () => {
  it('maps each (action, from) pair to exactly one transition', () => {
    const seen = new Set<string>();
    for (const transition of PO_TRANSITIONS) {
      const key = `${transition.action}:${transition.from}`;
      expect(seen.has(key), `duplicate transition ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it('encodes the submit → approve → reject lifecycle with the right roles and reasons', () => {
    const submit = findPurchaseOrderTransition('submit', 'DRAFT');
    expect(submit).toMatchObject({
      to: 'PENDING_APPROVAL',
      who: ['PURCHASING'],
      requiresReason: false,
    });

    const approve = findPurchaseOrderTransition('approve', 'PENDING_APPROVAL');
    expect(approve).toMatchObject({ to: 'APPROVED', who: ['MANAGER'], requiresReason: false });

    const reject = findPurchaseOrderTransition('reject', 'PENDING_APPROVAL');
    expect(reject).toMatchObject({ to: 'REJECTED', who: ['MANAGER'], requiresReason: true });
  });

  it('allows cancel only from DRAFT or PENDING_APPROVAL, by creator or manager, with a reason', () => {
    for (const from of ['DRAFT', 'PENDING_APPROVAL'] as const) {
      const cancel = findPurchaseOrderTransition('cancel', from);
      expect(cancel).toMatchObject({ to: 'CANCELLED', requiresReason: true });
      expect(cancel?.who).toEqual(expect.arrayContaining(['creator', 'MANAGER']));
    }
    // No cancel from APPROVED or later (PO-04).
    for (const from of ['APPROVED', 'PARTIALLY_RECEIVED', 'COMPLETED'] as const) {
      expect(findPurchaseOrderTransition('cancel', from)).toBeUndefined();
    }
  });

  it('has no transition out of a terminal REJECTED or CANCELLED order', () => {
    for (const from of ['REJECTED', 'CANCELLED'] as const) {
      const out = PO_TRANSITIONS.filter((t) => t.from === from);
      expect(out).toEqual([]);
    }
  });

  it('returns undefined for an illegal transition (e.g. approve a DRAFT, submit an APPROVED)', () => {
    expect(findPurchaseOrderTransition('approve', 'DRAFT')).toBeUndefined();
    expect(findPurchaseOrderTransition('submit', 'APPROVED')).toBeUndefined();
    expect(findPurchaseOrderTransition('reject', 'APPROVED')).toBeUndefined();
  });
});

describe('PurchaseOrderRejectInputSchema', () => {
  it('rejects a blank reason with the actionable Thai message', () => {
    const result = PurchaseOrderRejectInputSchema.safeParse({ id: 'po1', reason: '   ' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(PO_REJECT_REASON_REQUIRED_MESSAGE);
    }
  });

  it('accepts and trims a non-empty reason', () => {
    const result = PurchaseOrderRejectInputSchema.safeParse({
      id: 'po1',
      reason: '  ราคาสูงเกินไป  ',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reason).toBe('ราคาสูงเกินไป');
    }
  });
});

describe('PurchaseOrderCancelInputSchema', () => {
  it('rejects a blank reason with the actionable Thai message', () => {
    const result = PurchaseOrderCancelInputSchema.safeParse({ id: 'po1', reason: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(PO_CANCEL_REASON_REQUIRED_MESSAGE);
    }
  });

  it('accepts a non-empty reason', () => {
    expect(PurchaseOrderCancelInputSchema.safeParse({ id: 'po1', reason: 'สั่งซ้ำ' }).success).toBe(
      true,
    );
  });
});

import { describe, expect, it } from 'vitest';
import { GR_LINES_REQUIRED_MESSAGE, GR_QUANTITY_POSITIVE_MESSAGE } from './errors.js';
import {
  GoodsReceiptCreateInputSchema,
  GoodsReceiptLineInputSchema,
  GoodsReceiptSchema,
  ReceivableLineSchema,
  ReceivablePurchaseOrderSchema,
} from './goods-receipt.js';

describe('GoodsReceiptLineInputSchema', () => {
  const line = { purchaseOrderLineId: 'pol1', quantity: 8 };

  it('accepts a positive whole received quantity', () => {
    expect(GoodsReceiptLineInputSchema.safeParse(line).success).toBe(true);
  });

  it('rejects a zero quantity with the actionable Thai message', () => {
    const result = GoodsReceiptLineInputSchema.safeParse({ ...line, quantity: 0 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(GR_QUANTITY_POSITIVE_MESSAGE);
    }
  });

  it('rejects a fractional quantity with the actionable Thai message', () => {
    const result = GoodsReceiptLineInputSchema.safeParse({ ...line, quantity: 2.5 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(GR_QUANTITY_POSITIVE_MESSAGE);
    }
  });

  it('rejects a negative quantity', () => {
    expect(GoodsReceiptLineInputSchema.safeParse({ ...line, quantity: -3 }).success).toBe(false);
  });

  it('coerces a numeric string quantity', () => {
    const result = GoodsReceiptLineInputSchema.safeParse({ ...line, quantity: '8' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.quantity).toBe(8);
  });
});

describe('GoodsReceiptCreateInputSchema', () => {
  const input = {
    purchaseOrderId: 'po1',
    lines: [{ purchaseOrderLineId: 'pol1', quantity: 8 }],
  };

  it('accepts a receipt with at least one line', () => {
    expect(GoodsReceiptCreateInputSchema.safeParse(input).success).toBe(true);
  });

  it('rejects a receipt with no lines with the actionable Thai message', () => {
    const result = GoodsReceiptCreateInputSchema.safeParse({ ...input, lines: [] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(GR_LINES_REQUIRED_MESSAGE);
    }
  });

  it('rejects a receipt without a purchase order id', () => {
    expect(
      GoodsReceiptCreateInputSchema.safeParse({ purchaseOrderId: '', lines: input.lines }).success,
    ).toBe(false);
  });
});

describe('GoodsReceiptSchema', () => {
  it('accepts a serialized goods receipt with its lines', () => {
    const receipt = {
      id: 'gr1',
      number: 'GR-000001',
      purchaseOrderId: 'po1',
      storeId: 's1',
      receivedById: 'u1',
      lines: [
        {
          id: 'grl1',
          purchaseOrderLineId: 'pol1',
          productId: 'p1',
          sku: 'SKU001',
          productName: 'Drinking water pack of 6',
          quantity: 8,
        },
      ],
      createdAt: new Date().toISOString(),
    };
    expect(GoodsReceiptSchema.safeParse(receipt).success).toBe(true);
  });
});

describe('ReceivablePurchaseOrderSchema', () => {
  it('accepts a receivable view with ordered/received/outstanding per line', () => {
    const line = {
      purchaseOrderLineId: 'pol1',
      productId: 'p1',
      sku: 'SKU001',
      productName: 'Drinking water pack of 6',
      ordered: 20,
      received: 0,
      outstanding: 20,
    };
    expect(ReceivableLineSchema.safeParse(line).success).toBe(true);

    const view = {
      id: 'po1',
      number: 'PO-DEMO-001',
      status: 'APPROVED',
      storeId: 's1',
      lines: [line],
    };
    expect(ReceivablePurchaseOrderSchema.safeParse(view).success).toBe(true);
  });
});

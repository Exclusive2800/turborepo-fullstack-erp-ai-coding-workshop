import { oc } from '@orpc/contract';
import * as z from 'zod';
import { GR_LINES_REQUIRED_MESSAGE, GR_QUANTITY_POSITIVE_MESSAGE } from './errors.js';
import { paginated, PaginationInputSchema } from './pagination.js';
import { PurchaseOrderStatusSchema } from './purchase-order.js';

/**
 * A received quantity on a goods-receipt line (GR-02). Positive whole number: zero, negative and
 * fractional quantities are rejected at the contract boundary with one actionable Thai message.
 */
export const ReceivedQuantitySchema = z.coerce
  .number({ message: GR_QUANTITY_POSITIVE_MESSAGE })
  .int({ message: GR_QUANTITY_POSITIVE_MESSAGE })
  .positive({ message: GR_QUANTITY_POSITIVE_MESSAGE });
export type ReceivedQuantity = z.infer<typeof ReceivedQuantitySchema>;

/** One line on a receive request: the PO line being fulfilled and the quantity received now. */
export const GoodsReceiptLineInputSchema = z.object({
  purchaseOrderLineId: z.string().min(1),
  quantity: ReceivedQuantitySchema,
});
export type GoodsReceiptLineInput = z.infer<typeof GoodsReceiptLineInputSchema>;

/**
 * Recording a goods receipt against an approved purchase order (GR-01/GR-02/GR-03/GR-04). The
 * destination store is never part of the input — the handler derives it from the authenticated
 * principal and the order (store scoping, spec #1). At least one received line is required;
 * cumulative-received and line-on-order rules are enforced server-side against the order.
 *
 * `idempotencyKey` is an optional client-supplied key (GR-04): sending the same key again — a double
 * click, a retried request after a flaky network — returns the original receipt without raising
 * stock a second time, while a fresh key creates a genuine second receipt. The key is
 * unique-constrained in the database, so the guarantee holds even for two requests racing in
 * parallel. Omitting it keeps the #9 behaviour (every request is a new receipt).
 */
export const GoodsReceiptCreateInputSchema = z.object({
  purchaseOrderId: z.string().min(1),
  lines: z.array(GoodsReceiptLineInputSchema).min(1, { message: GR_LINES_REQUIRED_MESSAGE }),
  idempotencyKey: z.string().min(1).optional(),
});
export type GoodsReceiptCreateInput = z.infer<typeof GoodsReceiptCreateInputSchema>;

/**
 * A stored goods-receipt line as the API exposes it. `sku`/`productName` are a snapshot taken at
 * receipt time so history never changes when the product master is later edited; `quantity` is the
 * positive whole number received on this receipt for this line.
 */
export const GoodsReceiptLineSchema = z.object({
  id: z.string(),
  purchaseOrderLineId: z.string(),
  productId: z.string(),
  sku: z.string(),
  productName: z.string(),
  quantity: z.number().int().positive(),
});
export type GoodsReceiptLine = z.infer<typeof GoodsReceiptLineSchema>;

/**
 * A goods receipt as the API exposes it. `number` is the unique document number allocated at
 * confirmation (Section 4.3). A receipt is immutable once written (append-only, like the ledger):
 * there is no `updatedAt`.
 */
export const GoodsReceiptSchema = z.object({
  id: z.string(),
  number: z.string(),
  purchaseOrderId: z.string(),
  storeId: z.string(),
  receivedById: z.string(),
  lines: z.array(GoodsReceiptLineSchema),
  createdAt: z.iso.datetime(),
});
export type GoodsReceipt = z.infer<typeof GoodsReceiptSchema>;

export const GoodsReceiptListSchema = paginated(GoodsReceiptSchema);
export type GoodsReceiptList = z.infer<typeof GoodsReceiptListSchema>;

/**
 * One line of the receiving view (Seam 3). For each PO line the screen shows the ordered quantity,
 * how much has been received across all prior receipts, and the outstanding remainder
 * (`outstanding = ordered − received`), so a store employee knows what is left to receive (GR-01).
 */
export const ReceivableLineSchema = z.object({
  purchaseOrderLineId: z.string(),
  productId: z.string(),
  sku: z.string(),
  productName: z.string(),
  ordered: z.number().int().nonnegative(),
  received: z.number().int().nonnegative(),
  outstanding: z.number().int().nonnegative(),
});
export type ReceivableLine = z.infer<typeof ReceivableLineSchema>;

/** The receiving view for one purchase order: its identity, status and per-line receive progress. */
export const ReceivablePurchaseOrderSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: PurchaseOrderStatusSchema,
  storeId: z.string(),
  lines: z.array(ReceivableLineSchema),
});
export type ReceivablePurchaseOrder = z.infer<typeof ReceivablePurchaseOrderSchema>;

export const GoodsReceiptListInputSchema = PaginationInputSchema.extend({
  purchaseOrderId: z.string().min(1).optional(),
});
export type GoodsReceiptListInput = z.infer<typeof GoodsReceiptListInputSchema>;

export const ReceivableGetInputSchema = z.object({ purchaseOrderId: z.string().min(1) });
export type ReceivableGetInput = z.infer<typeof ReceivableGetInputSchema>;

export const goodsReceiptContract = {
  list: oc
    .route({
      method: 'GET',
      path: '/goods-receipts',
      summary: 'List goods receipts, newest first',
      tags: ['Goods receipts'],
    })
    .input(GoodsReceiptListInputSchema)
    .output(GoodsReceiptListSchema),
  receivable: oc
    .route({
      method: 'GET',
      path: '/goods-receipts/receivable/{purchaseOrderId}',
      summary: 'Get a purchase order with ordered/received/outstanding per line for receiving',
      tags: ['Goods receipts'],
    })
    .input(ReceivableGetInputSchema)
    .output(ReceivablePurchaseOrderSchema),
  receive: oc
    .route({
      method: 'POST',
      path: '/goods-receipts',
      summary:
        'Receive against an approved purchase order (atomic post-and-stock, advances the PO)',
      tags: ['Goods receipts'],
    })
    .input(GoodsReceiptCreateInputSchema)
    .output(GoodsReceiptSchema),
};

import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  PO_DUPLICATE_SKU_MESSAGE,
  PO_LINES_REQUIRED_MESSAGE,
  PO_QUANTITY_POSITIVE_MESSAGE,
  PO_UNIT_PRICE_NONNEGATIVE_MESSAGE,
} from './errors.js';
import { paginated, PaginationInputSchema } from './pagination.js';

/**
 * The full purchase-order lifecycle (PO-03, spec #1 "PO/GR state machine"). Mirrors the Prisma
 * `PurchaseOrderStatus` enum. The complete set is modelled now so #8 (the state machine) and #9
 * (goods receipt) can add transitions without reshaping the model, but #7 only ever *writes*
 * `DRAFT`: a draft PO is created at `DRAFT` and users never set the status directly — a valid
 * transition (owned by #8) is the only thing that advances it.
 *
 *   DRAFT → PENDING_APPROVAL → APPROVED → PARTIALLY_RECEIVED → COMPLETED
 *   plus REJECTED and CANCELLED (reachable per the transition table in #8).
 */
export const PurchaseOrderStatusSchema = z.enum([
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'PARTIALLY_RECEIVED',
  'COMPLETED',
  'REJECTED',
  'CANCELLED',
]);
export type PurchaseOrderStatus = z.infer<typeof PurchaseOrderStatusSchema>;

/**
 * An ordered quantity on a PO line (PO-02). Positive whole number: zero, negative and fractional
 * quantities are rejected at the contract boundary with one actionable Thai message.
 */
export const OrderedQuantitySchema = z.coerce
  .number({ message: PO_QUANTITY_POSITIVE_MESSAGE })
  .int({ message: PO_QUANTITY_POSITIVE_MESSAGE })
  .positive({ message: PO_QUANTITY_POSITIVE_MESSAGE });
export type OrderedQuantity = z.infer<typeof OrderedQuantitySchema>;

/**
 * A purchase unit price on a PO line (PO-02, Section 4.3 money rules). Non-negative, accepted as a
 * coerced number; a negative price is rejected with an actionable Thai message. Stored and returned
 * as a two-decimal money string.
 */
export const PurchaseUnitPriceSchema = z.coerce
  .number({ message: PO_UNIT_PRICE_NONNEGATIVE_MESSAGE })
  .nonnegative({ message: PO_UNIT_PRICE_NONNEGATIVE_MESSAGE });
export type PurchaseUnitPrice = z.infer<typeof PurchaseUnitPriceSchema>;

/** One line on a create request: the product plus its ordered quantity and purchase unit price. */
export const PurchaseOrderLineInputSchema = z.object({
  productId: z.string().min(1),
  quantity: OrderedQuantitySchema,
  unitPrice: PurchaseUnitPriceSchema,
});
export type PurchaseOrderLineInput = z.infer<typeof PurchaseOrderLineInputSchema>;

/**
 * A stored PO line as the API exposes it. The `productName` and `unitPrice` are a snapshot taken at
 * creation (Section 4.3): later edits to the product master never rewrite a stored line. `lineTotal`
 * is `quantity × unitPrice`, a two-decimal money string. `unitPrice` and `lineTotal` are money
 * strings; `productId`/`sku` keep the line linked to the catalogue for receiving (#9).
 */
export const PurchaseOrderLineSchema = z.object({
  id: z.string(),
  productId: z.string(),
  sku: z.string(),
  productName: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: z.string(),
  lineTotal: z.string(),
});
export type PurchaseOrderLine = z.infer<typeof PurchaseOrderLineSchema>;

/**
 * A purchase order as the API exposes it. `total` is the sum of the line totals (Section 4.3), a
 * two-decimal money string. `number` is the unique document number allocated at creation. `status`
 * is `DRAFT` for every order this ticket creates.
 */
export const PurchaseOrderSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: PurchaseOrderStatusSchema,
  supplierId: z.string(),
  storeId: z.string(),
  expectedReceiptDate: z.iso.datetime(),
  total: z.string(),
  lines: z.array(PurchaseOrderLineSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type PurchaseOrder = z.infer<typeof PurchaseOrderSchema>;

/**
 * Creating a draft purchase order (PO-01/PO-02). Requires a supplier, destination store, expected
 * receipt date and at least one line. A duplicate SKU — the same `productId` on more than one line
 * — is rejected here with an actionable Thai message; per-line quantity/price rules live on the
 * line schema. The status is never part of the input: the handler always creates at `DRAFT`.
 */
export const PurchaseOrderCreateInputSchema = z.object({
  supplierId: z.string().min(1),
  storeId: z.string().min(1),
  expectedReceiptDate: z.iso.datetime(),
  lines: z
    .array(PurchaseOrderLineInputSchema)
    .min(1, { message: PO_LINES_REQUIRED_MESSAGE })
    .superRefine((lines, ctx) => {
      const seen = new Set<string>();
      lines.forEach((line, index) => {
        if (seen.has(line.productId)) {
          ctx.addIssue({
            code: 'custom',
            message: PO_DUPLICATE_SKU_MESSAGE,
            path: [index, 'productId'],
          });
        }
        seen.add(line.productId);
      });
    }),
});
export type PurchaseOrderCreateInput = z.infer<typeof PurchaseOrderCreateInputSchema>;

export const PurchaseOrderListSchema = paginated(PurchaseOrderSchema);
export type PurchaseOrderList = z.infer<typeof PurchaseOrderListSchema>;

export const PurchaseOrderGetInputSchema = z.object({ id: z.string().min(1) });
export type PurchaseOrderGetInput = z.infer<typeof PurchaseOrderGetInputSchema>;

export const purchaseOrderContract = {
  list: oc
    .route({
      method: 'GET',
      path: '/purchase-orders',
      summary: 'List purchase orders, newest first',
      tags: ['Purchase orders'],
    })
    .input(PaginationInputSchema)
    .output(PurchaseOrderListSchema),
  get: oc
    .route({
      method: 'GET',
      path: '/purchase-orders/{id}',
      summary: 'Get one purchase order with its lines',
      tags: ['Purchase orders'],
    })
    .input(PurchaseOrderGetInputSchema)
    .output(PurchaseOrderSchema),
  create: oc
    .route({
      method: 'POST',
      path: '/purchase-orders',
      summary: 'Create a draft purchase order with validated lines',
      tags: ['Purchase orders'],
    })
    .input(PurchaseOrderCreateInputSchema)
    .output(PurchaseOrderSchema),
};

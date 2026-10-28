import { oc } from '@orpc/contract';
import * as z from 'zod';
import type { Role } from './auth.js';
import {
  PO_CANCEL_REASON_REQUIRED_MESSAGE,
  PO_DUPLICATE_SKU_MESSAGE,
  PO_LINES_REQUIRED_MESSAGE,
  PO_QUANTITY_POSITIVE_MESSAGE,
  PO_REJECT_REASON_REQUIRED_MESSAGE,
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
 * is driven only by valid transitions in {@link PO_TRANSITIONS} — never set directly. `statusReason`
 * is the mandatory reason captured on the last reject or cancel (PO-03/PO-04); it is null for an
 * order that has never been rejected or cancelled, so a rejected order stays viewable *with* the
 * explanation that was given.
 */
export const PurchaseOrderSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: PurchaseOrderStatusSchema,
  statusReason: z.string().nullable(),
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

/**
 * The actions that move a purchase order through its lifecycle. Each one is a *transition*, never a
 * direct status assignment: the user picks an action, the server looks it up in {@link PO_TRANSITIONS}
 * and rejects anything the table does not allow (PO-03). `receive` and `complete` are owned by goods
 * receipt (#9); they are listed here so the one authoritative table already contains the receiving
 * transitions #9 plugs into, but #8 only implements `submit`/`approve`/`reject`/`cancel`.
 */
export const PurchaseOrderActionSchema = z.enum([
  'submit',
  'approve',
  'reject',
  'cancel',
  'receive',
  'complete',
]);
export type PurchaseOrderAction = z.infer<typeof PurchaseOrderActionSchema>;

/** Who may drive a transition, and whether a reason is mandatory for it. */
export interface PurchaseOrderTransition {
  readonly action: PurchaseOrderAction;
  readonly from: PurchaseOrderStatus;
  readonly to: PurchaseOrderStatus;
  /**
   * The roles allowed to perform the transition. `creator` is a pseudo-role meaning "the user who
   * created the order"; the handler resolves it against the authenticated principal. An empty role
   * set would mean nobody, which never occurs.
   */
  readonly who: readonly (Role | 'creator')[];
  /** When true the transition requires a non-empty reason (PO-03 reject, PO-04 cancel). */
  readonly requiresReason: boolean;
}

/**
 * THE authoritative purchase-order transition table (spec #1 "PO/GR state machine", PO-03).
 *
 * This is the single source of truth for `from → to → who → required inputs`. The API rejects any
 * status change that is not a row here (illegal transition, or a direct status set); users never
 * set status directly. The lifecycle it encodes:
 *
 *   DRAFT ── submit ──▶ PENDING_APPROVAL ── approve ─▶ APPROVED ── receive ─▶ PARTIALLY_RECEIVED
 *                            │                              │                        │
 *                            │ reject                       │ receive (final)        │ receive
 *                            ▼                              ▼                        ▼
 *                         REJECTED                       COMPLETED  ◀── complete ── PARTIALLY_RECEIVED
 *
 *   cancel: DRAFT or PENDING_APPROVAL ──▶ CANCELLED (creator or manager, with a reason)
 *
 * A rejected order is terminal: there is no transition out of REJECTED, so it stays viewable and a
 * brand-new order is required to re-order (PO-03, story 25). Cancel is allowed only from DRAFT or
 * PENDING_APPROVAL, so an APPROVED or later order cannot be cancelled (PO-04, story 26).
 *
 * The `receive`/`complete` rows are the receiving transitions owned by #9; #8 does not implement
 * their handlers but keeps them in the one table so #9 plugs in without reshaping the state machine.
 */
export const PO_TRANSITIONS: readonly PurchaseOrderTransition[] = [
  {
    action: 'submit',
    from: 'DRAFT',
    to: 'PENDING_APPROVAL',
    who: ['PURCHASING'],
    requiresReason: false,
  },
  {
    action: 'approve',
    from: 'PENDING_APPROVAL',
    to: 'APPROVED',
    who: ['MANAGER'],
    requiresReason: false,
  },
  {
    action: 'reject',
    from: 'PENDING_APPROVAL',
    to: 'REJECTED',
    who: ['MANAGER'],
    requiresReason: true,
  },
  {
    action: 'cancel',
    from: 'DRAFT',
    to: 'CANCELLED',
    who: ['creator', 'MANAGER'],
    requiresReason: true,
  },
  {
    action: 'cancel',
    from: 'PENDING_APPROVAL',
    to: 'CANCELLED',
    who: ['creator', 'MANAGER'],
    requiresReason: true,
  },
  // Receiving (#9). Listed for completeness of the one authoritative table; #8 does not implement them.
  {
    action: 'receive',
    from: 'APPROVED',
    to: 'PARTIALLY_RECEIVED',
    who: ['STAFF'],
    requiresReason: false,
  },
  {
    action: 'receive',
    from: 'PARTIALLY_RECEIVED',
    to: 'PARTIALLY_RECEIVED',
    who: ['STAFF'],
    requiresReason: false,
  },
  { action: 'complete', from: 'APPROVED', to: 'COMPLETED', who: ['STAFF'], requiresReason: false },
  {
    action: 'complete',
    from: 'PARTIALLY_RECEIVED',
    to: 'COMPLETED',
    who: ['STAFF'],
    requiresReason: false,
  },
];

/**
 * Look up the single transition for `action` from `from`, or `undefined` if the table has no such
 * row (an illegal transition, which the API rejects). Every `(action, from)` pair in
 * {@link PO_TRANSITIONS} is unique, so at most one row matches.
 */
export function findPurchaseOrderTransition(
  action: PurchaseOrderAction,
  from: PurchaseOrderStatus,
): PurchaseOrderTransition | undefined {
  return PO_TRANSITIONS.find((t) => t.action === action && t.from === from);
}

/** Submitting a draft for approval (PO-02). No reason required. */
export const PurchaseOrderSubmitInputSchema = z.object({ id: z.string().min(1) });
export type PurchaseOrderSubmitInput = z.infer<typeof PurchaseOrderSubmitInputSchema>;

/** Approving a submitted order (PO-03). No reason required. */
export const PurchaseOrderApproveInputSchema = z.object({ id: z.string().min(1) });
export type PurchaseOrderApproveInput = z.infer<typeof PurchaseOrderApproveInputSchema>;

/** Rejecting a submitted order (PO-03). The reason is mandatory and trimmed non-empty. */
export const PurchaseOrderRejectInputSchema = z.object({
  id: z.string().min(1),
  reason: z.string().trim().min(1, { message: PO_REJECT_REASON_REQUIRED_MESSAGE }),
});
export type PurchaseOrderRejectInput = z.infer<typeof PurchaseOrderRejectInputSchema>;

/** Cancelling a Draft or Pending Approval order (PO-04). The reason is mandatory and trimmed. */
export const PurchaseOrderCancelInputSchema = z.object({
  id: z.string().min(1),
  reason: z.string().trim().min(1, { message: PO_CANCEL_REASON_REQUIRED_MESSAGE }),
});
export type PurchaseOrderCancelInput = z.infer<typeof PurchaseOrderCancelInputSchema>;

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
  submit: oc
    .route({
      method: 'POST',
      path: '/purchase-orders/{id}/submit',
      summary: 'Submit a draft purchase order for approval (DRAFT → PENDING_APPROVAL)',
      tags: ['Purchase orders'],
    })
    .input(PurchaseOrderSubmitInputSchema)
    .output(PurchaseOrderSchema),
  approve: oc
    .route({
      method: 'POST',
      path: '/purchase-orders/{id}/approve',
      summary: 'Approve a submitted purchase order (PENDING_APPROVAL → APPROVED)',
      tags: ['Purchase orders'],
    })
    .input(PurchaseOrderApproveInputSchema)
    .output(PurchaseOrderSchema),
  reject: oc
    .route({
      method: 'POST',
      path: '/purchase-orders/{id}/reject',
      summary: 'Reject a submitted purchase order with a reason (PENDING_APPROVAL → REJECTED)',
      tags: ['Purchase orders'],
    })
    .input(PurchaseOrderRejectInputSchema)
    .output(PurchaseOrderSchema),
  cancel: oc
    .route({
      method: 'POST',
      path: '/purchase-orders/{id}/cancel',
      summary: 'Cancel a Draft or Pending Approval purchase order with a reason (→ CANCELLED)',
      tags: ['Purchase orders'],
    })
    .input(PurchaseOrderCancelInputSchema)
    .output(PurchaseOrderSchema),
};

import { oc } from '@orpc/contract';
import * as z from 'zod';
import { ADJUSTMENT_REASON_REQUIRED_MESSAGE } from './errors.js';
import { paginated, PaginationInputSchema } from './pagination.js';

/**
 * Why a stock change happened (INV-02). Mirrors the Prisma `StockMovementType` enum and is an OPEN
 * set by design (spec #1): this release emits OPENING (seeded opening balances), ADJUSTMENT (#6),
 * GOODS_RECEIPT (#7/#9) and SALE (#13/#14). Deferred kinds can be added without reshaping the
 * ledger, so downstream tickets extend this list rather than redefining movements.
 */
export const StockMovementTypeSchema = z.enum(['OPENING', 'ADJUSTMENT', 'GOODS_RECEIPT', 'SALE']);
export type StockMovementType = z.infer<typeof StockMovementTypeSchema>;

/**
 * A stock-search result row: one product in one store with its on-hand quantity and low-stock
 * status (INV-01, AC-08). `reorderThreshold` is null when the store has no threshold set for the
 * product; `lowStock` is true only when a threshold exists and `quantity <= reorderThreshold`.
 * Zero-stock matches stay in the result set (they are not filtered out).
 */
export const StockItemSchema = z.object({
  productId: z.string(),
  sku: z.string(),
  name: z.string(),
  unit: z.string(),
  storeId: z.string(),
  storeCode: z.string(),
  quantity: z.number().int().nonnegative(),
  reorderThreshold: z.number().int().nonnegative().nullable(),
  lowStock: z.boolean(),
});
export type StockItem = z.infer<typeof StockItemSchema>;

/**
 * Search stock by SKU, product name and store (INV-01). `query` matches SKU or name
 * case-insensitively; `storeId` scopes to one store. Both optional: an empty search lists every
 * balance. Paginated and ordered by store code then SKU for a stable, scannable list.
 */
export const StockSearchInputSchema = PaginationInputSchema.extend({
  query: z.string().trim().max(200).optional(),
  storeId: z.string().min(1).optional(),
});
export type StockSearchInput = z.infer<typeof StockSearchInputSchema>;

export const StockSearchResultSchema = paginated(StockItemSchema);
export type StockSearchResult = z.infer<typeof StockSearchResultSchema>;

/**
 * An append-only ledger row as the API exposes it (INV-02). Immutable: there is no update or
 * delete route. `actorId` is null for system-seeded opening balances. `reason` carries the
 * mandatory manager reason for an ADJUSTMENT movement (INV-05) and is null for every other kind.
 * Reused by the movement-history report (#19).
 */
export const StockMovementSchema = z.object({
  id: z.string(),
  productId: z.string(),
  storeId: z.string(),
  qtyChange: z.number().int(),
  balanceBefore: z.number().int().nonnegative(),
  balanceAfter: z.number().int().nonnegative(),
  type: StockMovementTypeSchema,
  sourceDocument: z.string(),
  reason: z.string().nullable(),
  actorId: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type StockMovement = z.infer<typeof StockMovementSchema>;

/** List ledger movements, newest-first, optionally filtered by product, store and type (#19). */
export const StockMovementListInputSchema = PaginationInputSchema.extend({
  productId: z.string().min(1).optional(),
  storeId: z.string().min(1).optional(),
  type: StockMovementTypeSchema.optional(),
});
export type StockMovementListInput = z.infer<typeof StockMovementListInputSchema>;

export const StockMovementListSchema = paginated(StockMovementSchema);
export type StockMovementList = z.infer<typeof StockMovementListSchema>;

/**
 * A manager stock adjustment (INV-05). A MANAGER raises or lowers the on-hand quantity for one
 * product in one store by a signed, non-zero whole `qtyChange`, with a mandatory `reason`. The
 * reason is trimmed and must be non-empty — a blank or whitespace-only reason is rejected at the
 * contract boundary with an actionable Thai message. A decrease larger than the available balance
 * is rejected server-side (never-negative, INV-04), not here. The store is named explicitly
 * because a manager is cross-store; the handler still derives scope from the authenticated
 * principal.
 */
export const StockAdjustInputSchema = z.object({
  productId: z.string().min(1),
  storeId: z.string().min(1),
  qtyChange: z
    .number({ message: 'จำนวนที่ปรับต้องเป็นตัวเลข' })
    .int({ message: 'จำนวนที่ปรับต้องเป็นจำนวนเต็ม (ไม่มีเศษทศนิยม) กรุณาแก้ไข' })
    .refine((value) => value !== 0, {
      message: 'จำนวนที่ปรับต้องไม่เป็นศูนย์ กรุณาระบุจำนวนที่เพิ่มหรือลด',
    }),
  reason: z.string().trim().min(1, { message: ADJUSTMENT_REASON_REQUIRED_MESSAGE }).max(500),
});
export type StockAdjustInput = z.infer<typeof StockAdjustInputSchema>;

export const stockContract = {
  search: oc
    .route({
      method: 'GET',
      path: '/stock',
      summary: 'Search stock by SKU, name and store with quantity, threshold and low-stock flag',
      tags: ['Stock'],
    })
    .input(StockSearchInputSchema)
    .output(StockSearchResultSchema),
  movements: oc
    .route({
      method: 'GET',
      path: '/stock/movements',
      summary: 'List append-only stock-ledger movements, newest first',
      tags: ['Stock'],
    })
    .input(StockMovementListInputSchema)
    .output(StockMovementListSchema),
  adjust: oc
    .route({
      method: 'POST',
      path: '/stock/adjustments',
      summary: 'Manager stock adjustment (increase or decrease) with a mandatory reason',
      tags: ['Stock'],
    })
    .input(StockAdjustInputSchema)
    .output(StockMovementSchema),
};

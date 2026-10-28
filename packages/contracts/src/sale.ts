import { oc } from '@orpc/contract';
import * as z from 'zod';
import {
  SALE_DUPLICATE_PRODUCT_MESSAGE,
  SALE_LINES_REQUIRED_MESSAGE,
  SALE_QUANTITY_POSITIVE_MESSAGE,
} from './errors.js';
import { paginated, PaginationInputSchema } from './pagination.js';

/**
 * The sale lifecycle (SAL-01..SAL-04). Mirrors the Prisma `SaleStatus` enum. Both statuses are
 * modelled now so #14 (sale confirmation) can advance a sale without reshaping the model, but #13
 * only ever *writes* `DRAFT`: a draft sale is created at `DRAFT` and users never set the status
 * directly — confirmation (#14) is the only thing that moves it to `CONFIRMED`.
 */
export const SaleStatusSchema = z.enum(['DRAFT', 'CONFIRMED']);
export type SaleStatus = z.infer<typeof SaleStatusSchema>;

/**
 * A sold quantity on a sale line (SAL-01). Positive whole number: zero, negative and fractional
 * quantities are rejected at the contract boundary with one actionable Thai message.
 */
export const SoldQuantitySchema = z.coerce
  .number({ message: SALE_QUANTITY_POSITIVE_MESSAGE })
  .int({ message: SALE_QUANTITY_POSITIVE_MESSAGE })
  .positive({ message: SALE_QUANTITY_POSITIVE_MESSAGE });
export type SoldQuantity = z.infer<typeof SoldQuantitySchema>;

/**
 * One line on a create request: just the product and how many. There is deliberately NO price field
 * (SAL-02, controlled pricing): the server reads the product's current selling price itself and
 * snapshots it onto the line. Any `unitPrice` a client sends is stripped by the object schema and
 * never reaches the handler. The store is likewise never on the line — it is derived from the
 * authenticated principal, never the request body.
 */
export const SaleLineInputSchema = z.object({
  productId: z.string().min(1),
  quantity: SoldQuantitySchema,
});
export type SaleLineInput = z.infer<typeof SaleLineInputSchema>;

/**
 * A stored sale line as the API exposes it. `productName`, `sku` and `unitPrice` are a snapshot
 * taken at line creation (Section 4.3): later edits to the product master never rewrite a stored
 * line. `unitPrice` is the product's current selling price at creation — there is no client
 * override. `lineTotal` is `quantity × unitPrice`, a two-decimal money string. `unitPrice` and
 * `lineTotal` are money strings; `productId` keeps the line linked to the catalogue for #14.
 */
export const SaleLineSchema = z.object({
  id: z.string(),
  productId: z.string(),
  sku: z.string(),
  productName: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: z.string(),
  lineTotal: z.string(),
});
export type SaleLine = z.infer<typeof SaleLineSchema>;

/**
 * A sale as the API exposes it. `total` is the sum of the line totals (Section 4.3), a two-decimal
 * money string. `status` is `DRAFT` for a draft sale and `CONFIRMED` once confirmed (#14).
 * `storeId` is the store the sale was created for, derived from the authenticated principal.
 *
 * `documentNumber` and `confirmedAt` are null while the sale is a draft and are set together at
 * confirmation (#14): `documentNumber` is the unique "SAL" number allocated at confirmation and
 * `confirmedAt` is the confirmation timestamp (#17 keys the reporting day on it).
 */
export const SaleSchema = z.object({
  id: z.string(),
  storeId: z.string(),
  status: SaleStatusSchema,
  total: z.string(),
  documentNumber: z.string().nullable(),
  confirmedAt: z.iso.datetime().nullable(),
  lines: z.array(SaleLineSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Sale = z.infer<typeof SaleSchema>;

/**
 * Creating a draft sale (SAL-01). Requires at least one line; a duplicate product — the same
 * `productId` on more than one line — is rejected here with an actionable Thai message; the
 * per-line positive-whole-number quantity rule lives on the line schema. There is no `storeId` and
 * no `status` in the input: the handler derives the store from the authenticated principal and
 * always creates at `DRAFT`. There is no price input either — pricing is controlled server-side.
 */
export const SaleCreateInputSchema = z.object({
  lines: z
    .array(SaleLineInputSchema)
    .min(1, { message: SALE_LINES_REQUIRED_MESSAGE })
    .superRefine((lines, ctx) => {
      const seen = new Set<string>();
      lines.forEach((line, index) => {
        if (seen.has(line.productId)) {
          ctx.addIssue({
            code: 'custom',
            message: SALE_DUPLICATE_PRODUCT_MESSAGE,
            path: [index, 'productId'],
          });
        }
        seen.add(line.productId);
      });
    }),
});
export type SaleCreateInput = z.infer<typeof SaleCreateInputSchema>;

export const SaleListSchema = paginated(SaleSchema);
export type SaleList = z.infer<typeof SaleListSchema>;

export const SaleGetInputSchema = z.object({ id: z.string().min(1) });
export type SaleGetInput = z.infer<typeof SaleGetInputSchema>;

/**
 * Confirming a draft sale (SAL-03, AC-05/AC-06, #14). The input names the draft to confirm and
 * carries an optional client-supplied `idempotencyKey`. There is no line or price input: the lines
 * were fixed and priced when the draft was created (#13), and confirmation only validates stock,
 * posts the deduction and transitions the sale.
 *
 * `idempotencyKey` reuses the goods-receipt mechanism (#11): the key is UNIQUE-constrained on
 * `Sale` in the database, so resending the same key — a double click, a retried request after a
 * flaky network, two tabs — returns the original confirmed sale and deducts no stock a second time.
 * The unique constraint, not an in-memory guard, is the source of truth, so the guarantee holds for
 * two requests racing in parallel. Omitting the key still confirms the sale once; it simply forgoes
 * safe-retry.
 */
export const SaleConfirmInputSchema = z.object({
  id: z.string().min(1),
  idempotencyKey: z.string().min(1).optional(),
});
export type SaleConfirmInput = z.infer<typeof SaleConfirmInputSchema>;

export const saleContract = {
  list: oc
    .route({
      method: 'GET',
      path: '/sales',
      summary: 'List sales, newest first',
      tags: ['Sales'],
    })
    .input(PaginationInputSchema)
    .output(SaleListSchema),
  get: oc
    .route({
      method: 'GET',
      path: '/sales/{id}',
      summary: 'Get one sale with its lines',
      tags: ['Sales'],
    })
    .input(SaleGetInputSchema)
    .output(SaleSchema),
  create: oc
    .route({
      method: 'POST',
      path: '/sales',
      summary: 'Create a draft sale with the current selling price snapshotted onto each line',
      tags: ['Sales'],
    })
    .input(SaleCreateInputSchema)
    .output(SaleSchema),
  confirm: oc
    .route({
      method: 'POST',
      path: '/sales/{id}/confirm',
      summary:
        'Confirm a draft sale (validate stock, deduct, allocate a number, idempotent) in one transaction',
      tags: ['Sales'],
    })
    .input(SaleConfirmInputSchema)
    .output(SaleSchema),
};

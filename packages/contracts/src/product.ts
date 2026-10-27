import { oc } from '@orpc/contract';
import * as z from 'zod';
import { paginated, PaginationInputSchema } from './pagination.js';

/**
 * Stock quantities are always whole, non-negative numbers (MD-02: "stock quantities are whole
 * numbers"). Reused wherever a quantity enters the catalogue or a document so a non-integer
 * quantity is rejected at the contract boundary with an actionable Thai message.
 */
export const StockQuantitySchema = z.coerce
  .number({ message: 'จำนวนต้องเป็นตัวเลขจำนวนเต็ม' })
  .int({ message: 'จำนวนต้องเป็นจำนวนเต็ม (ไม่มีเศษทศนิยม) กรุณาแก้ไข' })
  .nonnegative({ message: 'จำนวนต้องไม่ติดลบ กรุณาแก้ไข' });
export type StockQuantity = z.infer<typeof StockQuantitySchema>;

/** A per-store reorder threshold as part of a product payload. Non-negative whole number. */
export const ReorderThresholdInputSchema = z.object({
  storeId: z.string().min(1),
  threshold: z.coerce
    .number()
    .int({ message: 'จุดสั่งซื้อต้องเป็นจำนวนเต็ม กรุณาแก้ไข' })
    .nonnegative({ message: 'จุดสั่งซื้อต้องไม่ติดลบ กรุณาแก้ไข' }),
});
export type ReorderThresholdInput = z.infer<typeof ReorderThresholdInputSchema>;

/** A per-store reorder threshold as the API returns it. */
export const ReorderThresholdSchema = z.object({
  storeId: z.string(),
  threshold: z.number().int().nonnegative(),
});
export type ReorderThreshold = z.infer<typeof ReorderThresholdSchema>;

/** A product as the API exposes it. Selling price is a two-decimal string (money). */
export const ProductSchema = z.object({
  id: z.string(),
  sku: z.string(),
  name: z.string(),
  category: z.string(),
  unit: z.string(),
  sellingPrice: z.string(),
  active: z.boolean(),
  skuLocked: z.boolean(),
  thresholds: z.array(ReorderThresholdSchema),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Product = z.infer<typeof ProductSchema>;

/**
 * Creating a product. Selling price and every reorder threshold are rejected when negative
 * (MD-02). Price is two-decimal money accepted as a coerced number.
 */
export const ProductCreateInputSchema = z.object({
  sku: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(100),
  unit: z.string().trim().min(1).max(50),
  sellingPrice: z.coerce
    .number({ message: 'ราคาขายต้องเป็นตัวเลข' })
    .nonnegative({ message: 'ราคาขายต้องไม่ติดลบ กรุณาแก้ไข' }),
  active: z.boolean().default(true),
  thresholds: z.array(ReorderThresholdInputSchema).default([]),
});
export type ProductCreateInput = z.infer<typeof ProductCreateInputSchema>;

/**
 * Editing a product. The SKU is sent back but the API refuses to change it once a transaction
 * references the product (MD-01); the field stays here so an unchanged SKU round-trips.
 */
export const ProductUpdateInputSchema = ProductCreateInputSchema.extend({
  id: z.string().min(1),
});
export type ProductUpdateInput = z.infer<typeof ProductUpdateInputSchema>;

export const ProductListSchema = paginated(ProductSchema);
export type ProductList = z.infer<typeof ProductListSchema>;

/** Ask whether a product may be added to a *new* document (MD-02: deactivated products cannot). */
export const ProductDocumentCheckInputSchema = z.object({ id: z.string().min(1) });
export type ProductDocumentCheckInput = z.infer<typeof ProductDocumentCheckInputSchema>;

export const productContract = {
  list: oc
    .route({
      method: 'GET',
      path: '/products',
      summary: 'List products, newest first (includes deactivated for historical search)',
      tags: ['Products'],
    })
    .input(PaginationInputSchema)
    .output(ProductListSchema),
  create: oc
    .route({ method: 'POST', path: '/products', summary: 'Create a product', tags: ['Products'] })
    .input(ProductCreateInputSchema)
    .output(ProductSchema),
  update: oc
    .route({
      method: 'PUT',
      path: '/products/{id}',
      summary: 'Update a product',
      tags: ['Products'],
    })
    .input(ProductUpdateInputSchema)
    .output(ProductSchema),
  checkForDocument: oc
    .route({
      method: 'GET',
      path: '/products/{id}/document-eligibility',
      summary: 'Validate a product may be added to a new document (rejects deactivated products)',
      tags: ['Products'],
    })
    .input(ProductDocumentCheckInputSchema)
    .output(ProductSchema),
};

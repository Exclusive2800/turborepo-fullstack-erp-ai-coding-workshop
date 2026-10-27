import { oc } from '@orpc/contract';
import * as z from 'zod';
import { paginated, PaginationInputSchema } from './pagination.js';

/** A supplier as the API exposes it. */
export const SupplierSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  contactName: z.string().nullable(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Supplier = z.infer<typeof SupplierSchema>;

/** Contact fields are optional; empty strings are normalised to null by the API. */
export const SupplierCreateInputSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(100),
  contactName: z.string().trim().max(100).optional(),
  contactEmail: z.email().max(200).optional().or(z.literal('')),
  contactPhone: z.string().trim().max(50).optional(),
});
export type SupplierCreateInput = z.infer<typeof SupplierCreateInputSchema>;

export const SupplierUpdateInputSchema = SupplierCreateInputSchema.extend({
  id: z.string().min(1),
});
export type SupplierUpdateInput = z.infer<typeof SupplierUpdateInputSchema>;

export const SupplierListSchema = paginated(SupplierSchema);
export type SupplierList = z.infer<typeof SupplierListSchema>;

export const supplierContract = {
  list: oc
    .route({
      method: 'GET',
      path: '/suppliers',
      summary: 'List suppliers, newest first',
      tags: ['Suppliers'],
    })
    .input(PaginationInputSchema)
    .output(SupplierListSchema),
  create: oc
    .route({
      method: 'POST',
      path: '/suppliers',
      summary: 'Create a supplier',
      tags: ['Suppliers'],
    })
    .input(SupplierCreateInputSchema)
    .output(SupplierSchema),
  update: oc
    .route({
      method: 'PUT',
      path: '/suppliers/{id}',
      summary: 'Update a supplier',
      tags: ['Suppliers'],
    })
    .input(SupplierUpdateInputSchema)
    .output(SupplierSchema),
};

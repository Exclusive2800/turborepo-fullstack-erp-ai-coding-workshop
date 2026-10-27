import { oc } from '@orpc/contract';
import * as z from 'zod';
import { paginated, PaginationInputSchema } from './pagination.js';

/** A store (branch) as the API exposes it. */
export const StoreSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Store = z.infer<typeof StoreSchema>;

export const StoreCreateInputSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(100),
});
export type StoreCreateInput = z.infer<typeof StoreCreateInputSchema>;

export const StoreUpdateInputSchema = StoreCreateInputSchema.extend({
  id: z.string().min(1),
});
export type StoreUpdateInput = z.infer<typeof StoreUpdateInputSchema>;

export const StoreListSchema = paginated(StoreSchema);
export type StoreList = z.infer<typeof StoreListSchema>;

export const storeContract = {
  list: oc
    .route({
      method: 'GET',
      path: '/stores',
      summary: 'List stores, newest first',
      tags: ['Stores'],
    })
    .input(PaginationInputSchema)
    .output(StoreListSchema),
  create: oc
    .route({ method: 'POST', path: '/stores', summary: 'Create a store', tags: ['Stores'] })
    .input(StoreCreateInputSchema)
    .output(StoreSchema),
  update: oc
    .route({ method: 'PUT', path: '/stores/{id}', summary: 'Update a store', tags: ['Stores'] })
    .input(StoreUpdateInputSchema)
    .output(StoreSchema),
};

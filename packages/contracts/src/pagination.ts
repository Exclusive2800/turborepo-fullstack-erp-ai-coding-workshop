import * as z from 'zod';

/**
 * Shared list conventions reused by every paginated screen.
 * - `page` is 1-based; `pageSize` is bounded so a client can't ask for the whole table.
 * - List endpoints return newest-first and report the total so the UI can show "page x of y".
 */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export const PaginationInputSchema = z.object({
  page: z.number().int().positive().default(1),
  pageSize: z.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
export type PaginationInput = z.infer<typeof PaginationInputSchema>;

/** Wrap a row schema into the paginated envelope every list endpoint returns. */
export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
  });
}

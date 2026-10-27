import { describe, expect, it } from 'vitest';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, PaginationInputSchema } from './pagination.js';

describe('PaginationInputSchema', () => {
  it('defaults to page 1 and the default page size', () => {
    const result = PaginationInputSchema.parse({});

    expect(result).toEqual({ page: 1, pageSize: DEFAULT_PAGE_SIZE });
  });

  it('coerces string query params to numbers', () => {
    // GET requests carry page/pageSize as query strings, so the schema must accept "1"/"20".
    const result = PaginationInputSchema.parse({ page: '2', pageSize: '50' });

    expect(result).toEqual({ page: 2, pageSize: 50 });
  });

  it('rejects a page size above the maximum', () => {
    expect(PaginationInputSchema.safeParse({ pageSize: String(MAX_PAGE_SIZE + 1) }).success).toBe(
      false,
    );
  });

  it('rejects a non-positive page', () => {
    expect(PaginationInputSchema.safeParse({ page: '0' }).success).toBe(false);
  });
});

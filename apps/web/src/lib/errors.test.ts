import {
  PO_DUPLICATE_SKU_MESSAGE,
  PO_UNIT_PRICE_NONNEGATIVE_MESSAGE,
  RETRY_MESSAGE,
  VALIDATION_MESSAGE,
} from '@erp/contracts';
import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';

describe('apiErrorMessage', () => {
  it('surfaces the contract validation message a 400 carries in its issues', async () => {
    const { apiErrorMessage } = await import('./errors');

    // oRPC rejects bad input with a BAD_REQUEST whose data.issues are the Zod schema's own issues.
    const error = new ORPCError('BAD_REQUEST', {
      status: 400,
      message: 'Input validation failed',
      data: { issues: [{ message: PO_DUPLICATE_SKU_MESSAGE, path: [0, 'productId'] }] },
    });

    expect(apiErrorMessage(error)).toBe(PO_DUPLICATE_SKU_MESSAGE);
  });

  it('surfaces the first actionable issue message when several are present', async () => {
    const { apiErrorMessage } = await import('./errors');

    const error = new ORPCError('BAD_REQUEST', {
      status: 400,
      data: {
        issues: [
          { message: PO_UNIT_PRICE_NONNEGATIVE_MESSAGE, path: [0, 'unitPrice'] },
          { message: PO_DUPLICATE_SKU_MESSAGE, path: [1, 'productId'] },
        ],
      },
    });

    expect(apiErrorMessage(error)).toBe(PO_UNIT_PRICE_NONNEGATIVE_MESSAGE);
  });

  it('falls back to the generic message for a 400 with no issue messages', async () => {
    const { apiErrorMessage } = await import('./errors');

    const error = new ORPCError('BAD_REQUEST', { status: 400, message: 'Input validation failed' });

    expect(apiErrorMessage(error)).toBe(VALIDATION_MESSAGE);
  });

  it('shows the Thai message a business error (409) authored', async () => {
    const { apiErrorMessage } = await import('./errors');

    const error = new ORPCError('CONFLICT', { status: 409, message: PO_DUPLICATE_SKU_MESSAGE });

    expect(apiErrorMessage(error)).toBe(PO_DUPLICATE_SKU_MESSAGE);
  });

  it('asks the user to retry for an unexpected failure', async () => {
    const { apiErrorMessage } = await import('./errors');

    expect(apiErrorMessage(new Error('boom'))).toBe(RETRY_MESSAGE);
  });
});

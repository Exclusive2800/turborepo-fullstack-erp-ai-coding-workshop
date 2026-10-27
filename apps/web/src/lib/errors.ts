import { RETRY_MESSAGE, VALIDATION_MESSAGE } from '@erp/contracts';
import { ORPCError } from '@orpc/client';

/**
 * The actionable Thai message to show for a failed mutation.
 * - A business error the API authored (e.g. a duplicate code) already carries a Thai `message`.
 * - A client-side validation rejection (400) maps to the shared "correct your input" message.
 * - Anything else is an unexpected failure: ask the user to retry.
 */
export function apiErrorMessage(error: unknown): string {
  if (error instanceof ORPCError) {
    if (error.status === 400) return VALIDATION_MESSAGE;
    if (typeof error.message === 'string' && error.message.trim() !== '') return error.message;
  }
  return RETRY_MESSAGE;
}

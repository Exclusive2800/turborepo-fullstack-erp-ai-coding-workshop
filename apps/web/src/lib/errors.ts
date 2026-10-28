import { RETRY_MESSAGE, VALIDATION_MESSAGE } from '@erp/contracts';
import { ORPCError } from '@orpc/client';

/** One Standard Schema issue as oRPC puts them on a 400 validation error's `data`. */
interface ValidationIssue {
  message: string;
}

/**
 * The actionable Thai message a 400 carries, if any. When a contract Zod schema rejects the input
 * (e.g. a duplicate SKU or a negative price on a PO line), oRPC throws a `BAD_REQUEST` whose
 * `data.issues` are the schema's own issues — each `message` is the actionable Thai string the
 * contract authored. Surface the first one; fall back to the generic message when there is none.
 */
function validationIssueMessage(error: ORPCError<string, unknown>): string {
  const data = error.data;
  if (data && typeof data === 'object' && 'issues' in data) {
    const issues = (data as { issues: unknown }).issues;
    if (Array.isArray(issues)) {
      const named = (issues as ValidationIssue[]).find(
        (issue) => typeof issue?.message === 'string' && issue.message.trim() !== '',
      );
      if (named) return named.message;
    }
  }
  return VALIDATION_MESSAGE;
}

/**
 * The actionable Thai message to show for a failed mutation.
 * - A business error the API authored (e.g. a duplicate code) already carries a Thai `message`.
 * - A contract validation rejection (400) carries the schema's own actionable message in
 *   `data.issues`; surface that, or the shared "correct your input" message when absent.
 * - Anything else is an unexpected failure: ask the user to retry.
 */
export function apiErrorMessage(error: unknown): string {
  if (error instanceof ORPCError) {
    if (error.status === 400) return validationIssueMessage(error);
    if (typeof error.message === 'string' && error.message.trim() !== '') return error.message;
  }
  return RETRY_MESSAGE;
}

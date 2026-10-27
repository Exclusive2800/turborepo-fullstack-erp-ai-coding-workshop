import { duplicateCodeMessage } from '@erp/contracts';
import { ORPCError } from '@orpc/nest';
import { isUniqueConstraintError } from './prisma-errors.js';

/**
 * Prisma returns `createdAt`/`updatedAt` as `Date`; the contract's output schema expects ISO
 * strings. Serialising in one place keeps every master-data handler consistent.
 */
export function serializeTimestamps<T extends { createdAt: Date; updatedAt: Date }>(row: T) {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

/**
 * Translate a duplicate unique code (Prisma P2002) into an actionable Thai CONFLICT, and rethrow
 * anything else untouched. Shared so every create/update handler reports a duplicate the same way
 * without leaking the underlying database error.
 */
export function throwIfDuplicateCode(code: string, error: unknown): never {
  if (isUniqueConstraintError(error)) {
    throw new ORPCError('CONFLICT', { message: duplicateCodeMessage(code) });
  }
  throw error;
}

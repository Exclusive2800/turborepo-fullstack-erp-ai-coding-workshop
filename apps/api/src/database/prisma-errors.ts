/**
 * Prisma surfaces a unique-constraint violation as error code `P2002`.
 * Detecting it here lets handlers translate it into an actionable, user-facing
 * message without leaking the underlying database error or a stack trace.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}

import { CROSS_STORE_ROLES, type User } from '@erp/contracts';
import { ORPCError } from '@orpc/nest';

/**
 * The authenticated caller enriched with their store assignment.
 * `assignedStoreId` is the single store a STAFF employee is pinned to, and null for cross-store roles.
 */
export type StoreScopedUser = User & { assignedStoreId: string | null };

function isCrossStore(user: StoreScopedUser): boolean {
  return CROSS_STORE_ROLES.includes(user.role);
}

/**
 * Enforce that `user` may act on `targetStoreId`.
 *
 * A cross-store role (ADMIN, MANAGER, PURCHASING) may act for any store. A store-scoped role (STAFF)
 * may act only for the single store it is assigned to. The caller derives `targetStoreId` from the
 * authenticated principal via {@link resolveStoreScope}, never from the request body.
 */
export function assertStoreScope(user: StoreScopedUser, targetStoreId: string): void {
  if (isCrossStore(user)) return;
  if (user.assignedStoreId && user.assignedStoreId === targetStoreId) return;
  throw new ORPCError('FORBIDDEN', { message: 'You cannot act for this store' });
}

/**
 * Resolve the store a caller may act on, deriving it from the session for store-scoped roles and
 * ignoring any store supplied in the request body.
 *
 * - STAFF: always their assigned store, whatever `requestedStoreId` claims. Rejects if unassigned.
 * - Cross-store roles: the `requestedStoreId` they named, which must be present.
 */
export function resolveStoreScope(
  user: StoreScopedUser,
  requestedStoreId: string | undefined,
): string {
  if (!isCrossStore(user)) {
    if (!user.assignedStoreId) {
      throw new ORPCError('FORBIDDEN', { message: 'You are not assigned to a store' });
    }
    return user.assignedStoreId;
  }
  if (!requestedStoreId) {
    throw new ORPCError('BAD_REQUEST', { message: 'A target store is required' });
  }
  return requestedStoreId;
}

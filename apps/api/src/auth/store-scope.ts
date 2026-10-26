import { isCrossStoreRole, type Whoami } from '@erp/contracts';
import { ORPCError } from '@orpc/nest';

/**
 * Enforce that `user` may act on `targetStoreId`.
 *
 * A cross-store role (ADMIN, MANAGER, PURCHASING) may act for any store. A store-scoped role (STAFF)
 * may act only for the single store it is assigned to. The caller derives `targetStoreId` from the
 * authenticated principal via {@link resolveStoreScope}, never from the request body.
 */
export function assertStoreScope(user: Whoami, targetStoreId: string): void {
  if (isCrossStoreRole(user.role)) return;
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
export function resolveStoreScope(user: Whoami, requestedStoreId: string | undefined): string {
  if (!isCrossStoreRole(user.role)) {
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

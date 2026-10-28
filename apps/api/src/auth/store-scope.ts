import {
  isCrossStoreRole,
  STORE_SCOPE_FORBIDDEN_MESSAGE,
  STORE_SCOPE_TARGET_REQUIRED_MESSAGE,
  STORE_SCOPE_UNASSIGNED_MESSAGE,
  type Whoami,
} from '@erp/contracts';
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
  throw new ORPCError('FORBIDDEN', { message: STORE_SCOPE_FORBIDDEN_MESSAGE });
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
      throw new ORPCError('FORBIDDEN', { message: STORE_SCOPE_UNASSIGNED_MESSAGE });
    }
    return user.assignedStoreId;
  }
  if (!requestedStoreId) {
    throw new ORPCError('BAD_REQUEST', { message: STORE_SCOPE_TARGET_REQUIRED_MESSAGE });
  }
  return requestedStoreId;
}

/**
 * Resolve the store scope for a READ (list/report) request, deriving it from the authenticated
 * principal and NEVER trusting the requested store alone. Returns the store id the rows must be
 * filtered to, or `null` for "every store".
 *
 * This is the read-side counterpart to {@link resolveStoreScope}: where that one requires a
 * cross-store caller to name a single target store (for a write), a read lets a cross-store caller
 * see every store at once.
 *
 * - A store-scoped role (STAFF) is pinned to its assigned store whatever `requestedStoreId` claims;
 *   if it is unassigned the request is rejected. It can never widen its view past its own store.
 * - A cross-store role (ADMIN, MANAGER, PURCHASING) sees every store (`null`), or the one store it
 *   named in the filter.
 */
export function resolveReadStoreScope(
  user: Whoami,
  requestedStoreId: string | undefined,
): string | null {
  if (!isCrossStoreRole(user.role)) {
    if (!user.assignedStoreId) {
      throw new ORPCError('FORBIDDEN', { message: STORE_SCOPE_UNASSIGNED_MESSAGE });
    }
    return user.assignedStoreId;
  }
  return requestedStoreId ?? null;
}

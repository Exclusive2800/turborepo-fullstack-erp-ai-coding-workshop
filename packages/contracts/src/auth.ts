import { oc } from '@orpc/contract';
import * as z from 'zod';

/**
 * The TOR's four-role model (Section 2), mapped 1:1 to the domain:
 * ADMIN (Administrator), PURCHASING (Purchasing officer), STAFF (Store employee), MANAGER (Manager).
 * Role says *what* a user may do; store assignment says *where*.
 */
export const RoleSchema = z.enum(['ADMIN', 'PURCHASING', 'STAFF', 'MANAGER']);
export type Role = z.infer<typeof RoleSchema>;

/**
 * Roles that act across every store. Only STAFF (a store employee) is pinned to one assigned store;
 * ADMIN, MANAGER and PURCHASING act head-office / cross-store.
 */
export const CROSS_STORE_ROLES: readonly Role[] = ['ADMIN', 'MANAGER', 'PURCHASING'];

/** The signed-in user as the API exposes it (never includes the password hash). */
export const UserSchema = z.object({
  id: z.string(),
  email: z.email(),
  name: z.string(),
  role: RoleSchema,
});
export type User = z.infer<typeof UserSchema>;

/**
 * A `whoami`-style view of the authenticated caller: the user plus the store they are pinned to.
 * `assignedStoreId` is null for cross-store roles (ADMIN, MANAGER).
 */
export const WhoamiSchema = UserSchema.extend({
  assignedStoreId: z.string().nullable(),
});
export type Whoami = z.infer<typeof WhoamiSchema>;

export const LoginInputSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof LoginInputSchema>;

export const SessionSchema = z.object({
  user: UserSchema.nullable(),
});
export type Session = z.infer<typeof SessionSchema>;

export const authContract = {
  login: oc
    .route({
      method: 'POST',
      path: '/auth/login',
      summary: 'Sign in with email and password',
      tags: ['Auth'],
    })
    .input(LoginInputSchema)
    .output(UserSchema),
  logout: oc.route({ method: 'POST', path: '/auth/logout', summary: 'Sign out', tags: ['Auth'] }),
  me: oc
    .route({
      method: 'GET',
      path: '/auth/me',
      summary: 'The signed-in user, or null',
      tags: ['Auth'],
    })
    .output(SessionSchema),
  whoami: oc
    .route({
      method: 'GET',
      path: '/auth/whoami',
      summary: 'The authenticated caller with their role and assigned store',
      tags: ['Auth'],
    })
    .output(WhoamiSchema),
};

import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Role } from '@erp/contracts';
import type { Request } from 'express';
import type { StoreScopedUser } from './store-scope.js';

export const IS_PUBLIC_KEY = 'auth:isPublic';
export const ROLES_KEY = 'auth:roles';

/** Every route requires a signed-in user unless it (or its controller) is marked `@Public()`. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Only users with one of these roles may call the route, e.g. `@Roles('ADMIN')`. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** The request after `AuthGuard` has run. `user` is unset on public routes without a session. */
export type AuthenticatedRequest = Request & { user?: StoreScopedUser };

/** The signed-in user, set by `AuthGuard`. Use as a parameter decorator next to `@Implement(...)`. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().user,
);

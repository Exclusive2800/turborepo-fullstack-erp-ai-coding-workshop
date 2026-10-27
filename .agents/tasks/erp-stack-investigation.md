# ERP Stack Investigation (read-only)

Repo: `c:\GitHub\turborepo-fullstack-erp-ai-coding-workshop`
Scope: inform a spec for the first ERP release. Stack confirmed per `AGENTS.md`: Turborepo + pnpm workspaces, Docker, apps `@erp/web` / `@erp/api`, packages `@erp/contracts` / `@erp/database`.

## Summary answers

1. **Authentication — IMPLEMENTED (full, cookie-session).** A working email/password login exists end to end: NestJS `AuthController` + global `AuthGuard` + HMAC-signed session cookie on the API; `/login` page, `RequireAuth` route guard, `useSession`/`useCurrentUser`, and automatic 401 → logout redirect on the web. Passwords are scrypt-hashed. No passport/JWT libraries; it is hand-rolled and deliberately simple.
2. **Authorization — IMPLEMENTED (role-based), NOT store-scoped.** A two-value `Role` enum (`ADMIN`, `STAFF`) exists in Prisma, the contract, and a working `@Roles(...)` guard check. There is **no** `Store`/`Organization`/tenant entity and **no** store-scoped or row-level access control anywhere.
3. **Contract pattern — ESTABLISHED.** `health` and `auth` are concrete reference implementations of the contract-first flow: Zod schema + `oc.route(...)` in `packages/contracts` → `@Implement(contract.x.y)` in a Nest controller → `useQuery`/`useMutation(orpc.x.y...)` on the web. Documented below with the full `health` example.
4. **Seed / test data — IMPLEMENTED (two demo users only).** Seed upserts `admin@erp.local` (ADMIN) and `staff@erp.local` (STAFF), both password `password`. No other fixtures (no products, customers, orders, stores).
5. **Testing — ESTABLISHED (Vitest everywhere).** API: Vitest Node, colocated `*.spec.ts`, oRPC `call()` + Nest `Test.createTestingModule`. Web: Vitest jsdom + Testing Library, colocated `*.test.tsx`, `fetch` stubbed via `mockApi`. Contracts/db: Vitest Node schema tests. Run with `pnpm test` (turbo) or `pnpm --filter <pkg> test`.
6. **Timezone / date handling — ABSENT.** No `Asia/Bangkok`, no timezone config, no date library (no luxon/date-fns/dayjs). Only raw `new Date().toISOString()` (API health timestamp) and `toLocaleTimeString()` (web display, browser-local). Postgres timestamp columns are `TIMESTAMP(3)` **without** time zone.
7. **Env / config — VALIDATED (4 vars).** `apps/api/src/config/env.ts` validates `NODE_ENV`, `PORT`, `DATABASE_URL`, `AUTH_SECRET` via Zod with defaults. `.env.example` additionally documents Docker/compose vars (`WEB_PORT`, `API_PORT`, `POSTGRES_*`) that are not consumed by the API env schema.

---

## Evidence

### 1. Authentication

**API side — fully present under `apps/api/src/auth/`:**

- `auth.module.ts` registers `AuthGuard` as an `APP_GUARD` (global): every route needs a session unless `@Public()`.
- `auth.controller.ts` implements three contract routes, and the whole controller is `@Public()`:
  - `login` — looks up the user by lowercased email, verifies the password with `verifyPassword` (`@erp/database`), and on success sets a cookie:
    ```ts
    const token = createSessionToken(user.id, this.config.get('AUTH_SECRET', { infer: true }));
    res.cookie(SESSION_COOKIE, token, { ...this.cookieOptions, maxAge: SESSION_TTL_MS });
    ```
    Cookie options: `httpOnly: true, sameSite: 'lax', secure: NODE_ENV === 'production', path: '/'`. Failure throws `ORPCError('UNAUTHORIZED')`.
  - `logout` — `res.clearCookie(SESSION_COOKIE, ...)`.
  - `me` — returns `{ user }` from the `@CurrentUser()` param (or `null`).
- `session-token.ts` — hand-rolled stateless token `"<userId>.<expiresAt>.<HMAC-SHA256>"`, 7-day TTL (`SESSION_TTL_MS`), verified with `timingSafeEqual`. Cookie name `erp_session`. Includes a `readCookie` parser. **No server-side session store** — the token is self-contained.
- `auth.guard.ts` — reads the cookie, verifies the token, loads the user via `PrismaService` into `request.user` (select `USER_SELECT = { id, email, name, role }`, no passwordHash), then enforces `@Public()` / presence / `@Roles()`.

**Password hashing — `packages/database/src/password.ts`:** `hashPassword`/`verifyPassword` using Node `scrypt`, format `scrypt:<saltHex>:<hashHex>`, 64-byte key, constant-time compare. Exported from `@erp/database`.

**Web side — fully present:**

- `apps/web/src/routes/login.tsx` — full login form (shadcn Card/Input/Label/Button), uses `useMutation(orpc.auth.login.mutationOptions(...))`, sets the `auth.me` query data on success, shows demo accounts, redirects via `safeRedirect`.
- `apps/web/src/components/require-auth.tsx` — layout route; shows "Loading…" while pending, else `<Navigate to="/login?redirect=...">` when no user.
- `apps/web/src/lib/auth.ts` — `useSession` (`orpc.auth.me` with `staleTime: Infinity`), `useCurrentUser`, `isUnauthorized`, `clearSession`, `safeRedirect` (blocks `//` open-redirects).
- `apps/web/src/lib/query-client.ts` — global `QueryCache`/`MutationCache` `onError` calls `clearSession` on any 401, so components never handle 401s.
- `apps/web/src/router.tsx` — `/login` is public; everything else is nested under `<RequireAuth />`.

**Absent:** passport, JWT libraries, OAuth/SSO, refresh tokens, server-side session persistence, password reset / email verification / signup, rate limiting on login, CSRF token (relies on `sameSite: 'lax'` + same-origin proxy), account lockout, MFA.

### 2. Authorization

- `packages/database/prisma/schema.prisma` — the **entire** domain model today:
  ```prisma
  enum Role { ADMIN STAFF }

  model User {
    id           String   @id @default(cuid())
    email        String   @unique
    name         String
    passwordHash String
    role         Role     @default(STAFF)
    createdAt    DateTime @default(now())
    updatedAt    DateTime @updatedAt
  }
  ```
- Contract mirror: `packages/contracts/src/auth.ts` → `RoleSchema = z.enum(['ADMIN','STAFF'])`, `UserSchema` (no passwordHash).
- Enforcement: `auth.guard.ts` reads `@Roles()` metadata and throws `ForbiddenException` when `role` doesn't match; `@Roles` / `@Public` / `@CurrentUser` live in `auth.decorators.ts`. Proven by `auth.guard.spec.ts` (admin-only route rejects STAFF, allows ADMIN).

**Absent:** any `Store`, `Branch`, `Organization`, `Tenant`, `Permission`, or `UserStore` entity; store-scoped / multi-tenant filtering; row-level security; per-resource ownership. Authorization is coarse role gating only, and only two roles exist.

### 3. Contract pattern (reference for new features)

The repo wires `contracts → api → web` for `auth` and `health`. The `health` route is the cleanest template:

**Contract — `packages/contracts/src/health.ts`:**
```ts
export const HealthCheckSchema = z.object({
  api: z.literal('ok'),
  database: z.enum(['ok', 'error']),
  timestamp: z.iso.datetime(),
});
export const healthContract = {
  check: oc.route({ method: 'GET', path: '/health', summary: '...', tags: ['Health'] })
    .output(HealthCheckSchema),
};
```
Registered in `packages/contracts/src/index.ts` as `contract = { auth, health }` (comment explicitly says to add e.g. `customers: customersContract` here). Input validation uses `.input(Schema)` (see `auth.login` with `LoginInputSchema`).

**API — `apps/api/src/health/health.controller.ts`:**
```ts
@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}
  @Public()
  @Implement(contract.health.check)
  check() {
    return implement(contract.health.check).handler(async () => {
      const database = await this.prisma.$queryRaw`SELECT 1`.then(() => 'ok' as const, () => 'error' as const);
      return { api: 'ok' as const, database, timestamp: new Date().toISOString() };
    });
  }
}
```
Pattern: one module per feature (`<feature>.module.ts` + `<feature>.controller.ts`), registered in `app.module.ts`; DB only via injected `PrismaService`; no class-validator DTOs; auth modifiers (`@Public`/`@Roles`/`@CurrentUser`) per route. Auth write example (`auth.controller.ts`) shows injecting `@Res({ passthrough: true })` for cookies.

**Web — `apps/web/src/components/health-status.tsx`:**
```ts
const health = useQuery(orpc.health.check.queryOptions());
```
Client is built once in `apps/web/src/lib/orpc.ts` from the shared `contract` via `OpenAPILink` (`url: window.location.origin + '/api'`) + `createTanstackQueryUtils`. Writes use `useMutation(orpc.x.y.mutationOptions())` (see `login.tsx`). Requests hit `/api` and Vite proxies to NestJS (`vite.config.ts` proxy `'/api' → http://localhost:3000`, `API_PROXY_TARGET` override for Docker). Global prefix `api` is set in `apps/api/src/main.ts`; contract paths do not repeat it.

### 4. Seed + test data

`packages/database/prisma/seed.ts`:
```ts
const demoUsers = [
  { email: 'admin@erp.local', name: 'Admin User', role: Role.ADMIN },
  { email: 'staff@erp.local', name: 'Staff User', role: Role.STAFF },
];
const DEMO_PASSWORD = 'password';
```
Upserts both users (idempotent; re-running resets them). These exact accounts are surfaced on the login page (`login.tsx` `demoAccounts`). Run via `pnpm db:seed` (→ `prisma db seed`). Seed uses `createPrismaClient` from `@erp/database` with `DATABASE_URL` fallback `postgresql://erp:erp@localhost:5432/erp`. **No other fixtures** exist. Single migration present: `packages/database/prisma/migrations/20261023121755_add_users/migration.sql` (creates `Role` enum + `User` table + unique email index).

### 5. Testing setup

Runner is **Vitest `^5.0.5`** in every package; `pnpm test` → `turbo run test` → each package's `vitest run`. Turbo `test` depends on `^build` + `db:generate`.

- **API** (`apps/api/vitest.config.ts`): `include: ['src/**/*.spec.ts']`, Node env. Patterns:
  - `src/health/health.controller.spec.ts` — `Test.createTestingModule({ controllers, providers: [{ provide: PrismaService, useValue: {...} }] })`, then `call(controller.check(), undefined)` from `@orpc/server`.
  - `src/auth/auth.controller.spec.ts` — mocks `PrismaService.user.findUnique` + `ConfigService`, fake Express `Response`, asserts cookie + `verifySessionToken`.
  - `src/auth/auth.guard.spec.ts` — hand-built `ExecutionContext`, a `RoutesUnderTest` class decorated with `@Public`/`@Roles`, exercises 401/403/success.
  - `src/auth/session-token.spec.ts` (present, token unit tests).
  - Command: `pnpm --filter @erp/api test`.
- **Web** (`apps/web/vite.config.ts` `test` block): `environment: 'jsdom'`, `setupFiles: ['./src/test/setup.ts']` (jest-dom + `cleanup`). Patterns:
  - `src/routes/login.test.tsx`, `src/components/require-auth.test.tsx`, `src/components/health-status.test.tsx` — render with `QueryClientProvider` + `createMemoryRouter`/`RouterProvider`, stub the API with `mockApi({ 'GET /auth/me': ... })` / `unauthorized()` from `src/test/mock-api.ts` (keyed `'<METHOD> <path without /api>'`, stubs global `fetch`).
  - Command: `pnpm --filter @erp/web test`.
- **Contracts** (`packages/contracts`): `src/auth.test.ts`, `src/health.test.ts` — pure Zod `safeParse` schema tests (valid/invalid cases, unknown role rejected). Command: `pnpm --filter @erp/contracts test`.
- **Database** (`packages/database`): `src/index.test.ts` (client builds without connecting), `src/password.test.ts`. Command: `pnpm --filter @erp/database test`.

Full gate (per root `AGENTS.md`): `pnpm check` = `turbo run lint typecheck test build`, plus `pnpm format`.

### 6. Timezone / date handling

No application-level date/timezone code exists. Searched for `Bangkok|timezone|timeZone|Intl.DateTimeFormat|luxon|date-fns|dayjs` — only `pnpm-lock.yaml` noise, no source hits. Current usage:
- API: `timestamp: new Date().toISOString()` (UTC, `health.controller.ts`); contract validates it as `z.iso.datetime()`.
- Web: `new Date(...).toLocaleTimeString()` (browser-local, `health-status.tsx`).
- DB: `createdAt`/`updatedAt` are Prisma `DateTime` → Postgres `TIMESTAMP(3)` **without time zone** (see migration SQL). No `Asia/Bangkok` anywhere, no `TZ` env var.

### 7. Env / config

`apps/api/src/config/env.ts` (Zod, fail-fast via `validateEnv`, wired in `app.module.ts` `ConfigModule.forRoot({ validate })`):
- `NODE_ENV` — `enum(['development','test','production'])`, default `development`.
- `PORT` — positive int, default `3000`.
- `DATABASE_URL` — URL, default `postgresql://erp:erp@localhost:5432/erp`.
- `AUTH_SECRET` — string min 32, default `dev-only-auth-secret-change-me-0123456789`.

`.env.example` documents (not all validated by the API schema): `WEB_PORT`, `API_PORT`, `POSTGRES_PORT`, `POSTGRES_USER/PASSWORD/DB`, `DATABASE_URL`, commented `AUTH_SECRET`. `turbo.json` `globalPassThroughEnv` also lists `HOST`, `API_PROXY_TARGET`, `WATCH_POLLING`, `CHOKIDAR_USEPOLLING`, `TSC_WATCHFILE`, `TSC_WATCHDIRECTORY`. Per `AGENTS.md`, new API env vars must be added to both `env.ts` and `.env.example`.

---

## Conclusions and recommendations (for the spec)

- **Auth is done and is the pattern to extend, not rebuild.** The spec should treat session login, role gating, scrypt hashing, and the 401→/login flow as existing infrastructure. New protected routes just add `@Implement` handlers (default-protected) and `@Roles('ADMIN')` where needed. Do not introduce passport/JWT — it would fight the established cookie-session design.
- **Authorization is coarse.** Only `ADMIN`/`STAFF` and no tenancy. If the TOR's first release needs store/branch scoping, per-store roles, or more granular permissions, that is **net-new modeling**: add `Store` (and a `User`↔`Store` relation) to `schema.prisma`, extend `RoleSchema`, and add scope checks (likely beyond the current metadata guard — consider a per-resource ownership check). Flag this as a design decision the TOR must settle.
- **Domain model is essentially empty** (only `User`). Every ERP entity (products, inventory, customers, orders, etc.) is greenfield. The `add-feature` skill recipe (Prisma model → contract → Nest module → React → tests) is the intended path; each new contract goes into `packages/contracts/src/index.ts`.
- **Timezone is unhandled and likely matters for a Thai retail ERP.** Timestamps are UTC/`TIMESTAMP(3)` and web rendering is browser-local. If the TOR requires `Asia/Bangkok` business days (daily reports, cut-off times, receipts), the spec needs an explicit decision: store UTC + format in Bangkok at the edges (recommended), or add a timezone config. There is no date library yet — choose one if non-trivial date math is required.
- **Test harness is ready for TDD**; new features should follow the three existing test styles. No DB-integration test harness exists (API specs mock `PrismaService`); if the spec wants true DB integration tests, that infrastructure is also net-new.
- **Env additions** must land in both `env.ts` (with Zod validation) and `.env.example`; set a real `AUTH_SECRET` outside the workshop.

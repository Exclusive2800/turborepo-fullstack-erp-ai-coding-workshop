# Ticket #2 — Standards Review (Axis 1)

Diff: `git diff d34cecb...HEAD` (ref resolves to `d34cecb6927...`, 13 files, non-empty).

## Documented-standard violations

**None that are hard violations.** ESM `.js` extensions are present on every new relative import (`store-scope.js`, `auth.decorators.js`). Contract routes are implemented via `@Implement(contract.auth.whoami)` returning `implement(...).handler(...)`, no class-validator DTOs, no self-declared routes. No new env vars were introduced, so `env.ts`/`.env.example` rules don't apply. The `whoami` handler reads the user through `@CurrentUser()` and touches no DB directly.

One borderline contract-first point (`apps/api/src/auth/store-scope.ts:7`): `StoreScopedUser = User & { assignedStoreId: string | null }` is hand-written in the api, but the contract already exports the identical shape as `WhoamiSchema` / `Whoami` (`packages/contracts/src/auth.ts:31`). The rule says apps should derive response types from the contract, not re-declare them. The handler returns `StoreScopedUser` for a route whose output is `WhoamiSchema`; importing `Whoami` would keep a single source of truth.

## Fowler smells (judgement calls)

**Duplicated Code / Speculative Generality — `store-scope.ts`.** `StoreScopedUser` duplicates the contract's `Whoami` type (see above). More notably, both exported helpers are **Speculative Generality**: grep confirms `assertStoreScope` and `resolveStoreScope` have no production caller anywhere in `apps/api/src` — they exist only with tests. Store-scope enforcement infrastructure is built ahead of any route that needs it.

**Divergent comment drift (Mysterious Name-adjacent).** `CROSS_STORE_ROLES` (`auth.ts:14`) and `schema.prisma:17` both list three cross-store roles (ADMIN, MANAGER, PURCHASING), but the `WhoamiSchema` docblock (`auth.ts:28`) and the `User.assignedStoreId` prose say "null for cross-store roles (ADMIN, MANAGER)", dropping PURCHASING. The authoritative list and its narration disagree.

**Inconsistent import source.** `store-scope.ts` imports `ORPCError` from `@orpc/nest`; `store-scope.spec.ts` imports it from `@orpc/server`. Same symbol, two package paths — minor Shotgun-Surgery risk if the import surface changes.

**Test seam leaking into style.** `store-scope.spec.ts` imports `assertStoreScope` statically but `resolveStoreScope` via `await import(...)` inside each test, and ends with a `_typecheck`/`void _typecheck` type-assertion hack. Inconsistent and noisy, though test-only.

No Feature Envy, Data Clumps, Repeated Switches, or Refused Bequest found in the added lines.

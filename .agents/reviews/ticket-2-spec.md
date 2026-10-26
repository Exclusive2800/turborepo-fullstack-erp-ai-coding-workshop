# Four-role and store-scoping foundation

The diff adds the four-role model, store assignments, scope helpers, `timestamptz` migration, and protected `whoami`. PURCHASING is consistently treated as a head-office cross-store role. Role/store invariants and seed reset behavior remain incomplete.

Watch for: **confirmed** role/store combinations are not enforced; **confirmed** the seed is neither the exact fixture nor a reset after upgrading an existing database.

**Verdict**: NEEDS_CHANGES

## High-level view

The scope helper correctly derives STAFF scope from the authenticated principal and permits cross-store roles. However, the database and `WhoamiSchema` both accept STAFF with no store and cross-store users with a store, so the principal itself does not always resolve as required.

The seed upserts five current accounts without deleting the former `staff@erp.local`, so a previously seeded installation retains an invalid sixth account.

<details>
<summary>Issues (2)</summary>

1. **Role/store invariant is optional (confirmed)** — Invalid STAFF and cross-store assignments pass persistence and contract validation; enforce the role-dependent invariant.
2. **Seed is not an exact reset (confirmed)** — The seed adds an unspecified admin and preserves the obsolete staff account; align it with the named fixture and remove stale rows.

</details>

<details>
<summary>Details</summary>

## Role/store invariant is optional

**Confirmed.** AC2 requires “a STAFF principal resolves to exactly one assigned store and a MANAGER/ADMIN principal resolves to cross-store.” `schema.prisma:34-35` makes the relation nullable without a role-dependent constraint, and `auth.ts:31-33` accepts either nullability for every role. Consequently, `whoami` can return STAFF with `assignedStoreId: null` or a cross-store role with a non-null store. Enforce the invariant when loading/authenticating principals and in contract validation; add a database constraint if persisted invalid states must be impossible.

## Seed does not produce or restore the exact fixture

**Confirmed.** The release spec requires a resettable seed producing “exactly the Section 8 fixture” and names `buyer01`, `staff_b01`, `staff_b02`, and `manager01`. `seed.ts:15-20` additionally seeds `admin@erp.local`, while its upsert-only loop never removes the old `staff@erp.local` present at the fixed point. Fresh databases get five users; upgraded seeded databases keep six, including an unassigned STAFF principal. Make reset semantics explicit and remove obsolete fixture rows; omit the extra admin unless the spec is amended.

</details>

<details>
<summary>File map</summary>

Auth contract/controller/guard files add roles, store-aware principals, helpers, and `whoami`; Prisma files add stores, assignments, and timestamp migration; seed/login files replace demo accounts. Full diff: `git diff d34cecb...HEAD`.

</details>

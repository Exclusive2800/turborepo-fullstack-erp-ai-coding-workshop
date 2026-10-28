# Retail ERP v1 — handover

This is the release handover for the Retail ERP v1 baseline (TOR v1.1, GitHub issue #1). It makes
the release installable and auditable: how to install, start, migrate, seed, and test from a clean
checkout; the example configuration; the test accounts; where the API documentation lives; and
pointers to the two companion registers this handover ships with.

- Known limitations and deferred scope: [`docs/known-limitations.md`](known-limitations.md)
- Resolved clarifications (TOR §10.1): [`docs/clarification-register.md`](clarification-register.md)

Everything below is runnable from a clean checkout. The commands are the real scripts in the root
[`package.json`](../package.json); none are invented. See the `repo-commands` skill for the Docker
vs host details and the common gotchas.

## What is in this release

A web ERP (the `@erp/web` + `@erp/api` + `@erp/contracts` + `@erp/database` monorepo) delivering
the TOR baseline: master data (products, stores, suppliers), an append-only stock-movement ledger,
purchase orders with an approval state machine, partial goods receipts, sales, and reports with CSV
export. Cookie-session authentication, a four-role model (`ADMIN`, `PURCHASING`, `STAFF`,
`MANAGER`), and hard store scoping are enforced by the API, not the UI. All integrity guarantees —
idempotent confirmation, concurrency safety, atomic post-and-stock, never-negative stock — are
enforced at the database.

The release scope, the out-of-scope items, and the deferred clarifications are listed in
[`docs/known-limitations.md`](known-limitations.md).

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine + Compose).
  This is the only hard requirement — the stack runs in Docker.
- [Git](https://git-scm.com/).
- Optional, for running on the host instead of in the container: Node `>=24` and `pnpm@12.15.0`
  (see the root `package.json` `engines`/`packageManager`). With these installed you can run every
  `pnpm` command directly on the host.

## Install (from a clean checkout)

```bash
git clone <your-fork-url> erp-workshop
cd erp-workshop
docker compose build             # dev image (Node 24 + pnpm)
docker compose pull postgres     # database image
docker compose run --rm install  # installs node_modules + builds the shared packages
```

`node_modules` is a bind mount shared by the host and the containers. Install in **one** place
only — never run `pnpm install` on both sides.

## Example configuration

Defaults work without a `.env` file. The API validates its environment on startup in
[`apps/api/src/config/env.ts`](../apps/api/src/config/env.ts); the template is
[`.env.example`](../.env.example). Copy it to `.env` only when you need to override a default (for
example, to change a port that is already in use):

```bash
cp .env.example .env
```

| Variable        | Default                                   | Purpose                                                               |
| --------------- | ----------------------------------------- | --------------------------------------------------------------------- |
| `DATABASE_URL`  | `postgresql://erp:erp@localhost:5432/erp` | Postgres connection string                                            |
| `AUTH_SECRET`   | a dev-only fallback                       | signs the session cookie — **set a real secret outside the workshop** |
| `WEB_PORT`      | `5173`                                    | web app port                                                          |
| `API_PORT`      | `3000`                                    | API port                                                              |
| `POSTGRES_PORT` | `5432`                                    | Postgres port                                                         |

Any new API environment variable must be added to both `apps/api/src/config/env.ts` (validated with
Zod) and `.env.example`. If a turbo task needs it, add it to `globalPassThroughEnv` in
[`turbo.json`](../turbo.json).

## Data structures and migrations

The data model lives in [`packages/database/prisma/schema.prisma`](../packages/database/prisma/schema.prisma):
`User`, `Store`, `Supplier`, `Product` (with a per-store reorder threshold), `StockMovement`
(append-only ledger), `StockBalance`, `PurchaseOrder` + `PurchaseOrderLine`, `GoodsReceipt` +
`GoodsReceiptLine`, `Sale` + `SaleLine`. All timestamps are stored in UTC (`@db.Timestamptz(3)`) and
converted to Asia/Bangkok only at the reporting boundary and for display.

Migrations are in `packages/database/prisma/migrations/` (11 at this release). Apply and manage them
with the root scripts:

```bash
pnpm db:deploy                      # apply all pending migrations (what dev:local runs)
pnpm db:migrate --name <change>     # create a new migration after editing schema.prisma
pnpm db:generate                    # regenerate the Prisma client (migrate dev does NOT do this)
pnpm db:status                      # show migration status
```

In Docker, prefix with `docker compose exec api ` (for example
`docker compose exec api pnpm db:deploy`).

## Resettable seed and the test accounts

The seed ([`packages/database/prisma/seed.ts`](../packages/database/prisma/seed.ts)) is idempotent
and resettable: it upserts exactly the TOR Section 8 fixture and deletes anything outside it, so
every run returns the database to a known clean state.

```bash
pnpm db:seed      # (re)apply the Section 8 fixture
pnpm db:reset     # wipe + re-migrate + seed (a full reset)
```

The seed produces: stores **B01** (Central) and **B02** (Riverside); supplier **SUP01**; three
products **SKU001** / **SKU002** / **SKU003** with a reorder threshold of 3 in each store (B01
opening stock 10 / 5 / 0 posted through the ledger, B02 all zero); and the Approved demo purchase
order **PO-DEMO-001** (20× SKU001 @ 45.00, destination B01, no receipts).

The seeded test accounts (non-production credentials, password `password` for all):

| Email                 | Role         | Assigned store  | Can do                                                        |
| --------------------- | ------------ | --------------- | ------------------------------------------------------------- |
| `admin@erp.local`     | `ADMIN`      | —               | maintain products, stores, suppliers (master data)            |
| `buyer01@erp.local`   | `PURCHASING` | — (cross-store) | create / submit purchase orders                               |
| `manager01@erp.local` | `MANAGER`    | — (cross-store) | approve / reject POs, stock adjustments, reports (all stores) |
| `staff_b01@erp.local` | `STAFF`      | B01             | receive and sell for **B01 only**                             |
| `staff_b02@erp.local` | `STAFF`      | B02             | receive and sell for **B02 only**                             |

> The TOR Section 7.2 deliverable calls for four roled test users (one per role). The seed ships a
> second `STAFF` user (`staff_b02`) so that store scoping — a `STAFF` user cannot act on another
> store — can be demonstrated and tested across two stores. All four roles are represented.

## Start the stack

```bash
docker compose up
```

| What               | URL                                 |
| ------------------ | ----------------------------------- |
| Web app            | http://localhost:5173               |
| API                | http://localhost:3000/api           |
| API docs (Swagger) | http://localhost:3000/api/docs      |
| Postgres (tools)   | `localhost:5432` user/pass/db `erp` |

Sign in with one of the test accounts above. Stop with `Ctrl+C` or `docker compose down` (add `-v`
to also delete the database volume).

On the host, if Node 24 + pnpm are installed, `pnpm dev:local` starts only Postgres in Docker,
applies migrations, regenerates the client, seeds, and runs both apps on the host. Do not run it
alongside `docker compose up` — they share the same ports.

Browse the database with Prisma Studio: `docker compose --profile tools up -d studio`
(http://localhost:5555).

## Tests

The full gate (lint, typecheck, test, build) and the formatter, from the repo root:

```bash
pnpm check     # turbo run lint typecheck test build
pnpm format    # prettier --write .
```

Run one task in one package with a filter, for example `pnpm turbo run test --filter=@erp/api`.

Browser (end-to-end) tests cover each ticket's `Demo:` line and run on the **host** (the dev image
has no browser):

```bash
# once per machine, download Chromium:
pnpm --filter @erp/e2e exec playwright install chromium
pnpm e2e
```

With `docker compose up` running, `pnpm e2e` reuses the `api` and `web` containers; with only
Postgres up it starts the API and a `vite preview` itself. The last report or a trace:
`pnpm --filter @erp/e2e exec playwright show-report`. See the `write-e2e` skill for details.

Two known test-infrastructure limitations (a missing Postgres service on the CI `check` job, and an
e2e worker-startup race) are documented in [`docs/known-limitations.md`](known-limitations.md).

## API documentation

The API is contract-first: [`packages/contracts`](../packages/contracts) is the single source of
truth (routes + Zod schemas), the API implements it, and the web calls it through a typed client.

The running API serves generated, always-in-sync documentation from the contract:

- Swagger UI: **http://localhost:3000/api/docs**
- OpenAPI JSON: **http://localhost:3000/api/openapi.json**

Both are generated from `contract` in [`packages/contracts/src/index.ts`](../packages/contracts/src/index.ts)
by [`apps/api/src/openapi/openapi.controller.ts`](../apps/api/src/openapi/openapi.controller.ts), so
they never drift from the implemented routes. The full route inventory delivered in this release is
in [`docs/api.md`](api.md).

## See also

- [`README.md`](../README.md) — the workshop starter guide.
- [`AGENTS.md`](../AGENTS.md), [`apps/api/AGENTS.md`](../apps/api/AGENTS.md),
  [`apps/web/AGENTS.md`](../apps/web/AGENTS.md) — repository conventions.
- [`docs/tors/Retail_ERP_TOR_EN.md`](tors/Retail_ERP_TOR_EN.md) — the Terms of Reference (v1.1).

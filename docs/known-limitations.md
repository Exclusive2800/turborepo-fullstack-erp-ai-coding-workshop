# Known-limitations register

What the Retail ERP v1 release does **not** do, and the deferred clarifications. Everything here is
deliberately out of the baseline per the TOR (v1.1, GitHub issue #1) and its clarification and
change registers. This register is a Section 7.2 handover deliverable; the resolved clarifications
it references in detail live in [`docs/clarification-register.md`](clarification-register.md).

## 1. Out-of-scope features (TOR Section 3)

Excluded from this release:

- General ledger, accounts payable / receivable, payroll, manufacturing.
- Tax calculation and tax invoices, discounts, real payments, inventory valuation, and cost of
  goods sold.
- External POS / ERP integration, inter-store transfers, batch and expiry tracking, returns, and
  migration of real business data.
- Cancellation of Approved or partially received orders (PO-04); editing or cancelling confirmed
  goods receipts or sales (receipt and sale history is immutable in this release).
- Customer personal data.

The data model leaves room for some deferred items (an open movement-type enum, an explicit PO
state machine) but none are implemented.

## 2. Deferred clarifications (TOR §10.1 clarification register)

Resolved as "out of the initial release." Each is recorded with its business decision, approving
stakeholder, and affected requirements in
[`docs/clarification-register.md`](clarification-register.md).

| ID   | Deferred decision                                                                     | Affected |
| ---- | ------------------------------------------------------------------------------------- | -------- |
| Q-01 | Single-manager approval only — no multi-approver, approval thresholds, or delegation. | PO-03    |
| Q-03 | No backdated receiving; the system confirmation timestamp is always used.             | GR       |
| Q-04 | No reversals of incorrect goods receipts or sales.                                    | GR, SAL  |
| Q-05 | One base unit per SKU — no purchase/sales unit conversion and no barcode scanning.    | MD-01    |

## 3. Deferred change request

| ID    | Status                                                                                                   |
| ----- | -------------------------------------------------------------------------------------------------------- |
| CR-01 | Damaged-goods-on-receipt (separate usable vs damaged quantities) — under consideration, not in baseline. |

## 4. Resolved clarification carried in scope

**Q-02** is **resolved and implemented**, not deferred: receiving against an already-Approved (or
Partially Received) purchase order is allowed even when the line's product was deactivated after
approval. Full decision, approving stakeholder, and covering tests are in
[`docs/clarification-register.md`](clarification-register.md).

## 5. Audit coverage (NFR-03)

Every business event that moves inventory or changes an order's status is traceable to the actor,
the time, the source document, and the outcome. The audit data lives in the normal domain tables
(no separate audit log is in scope), and it is readable only through routes behind the global
`AuthGuard` with the same role and store-scope rules as the rest of the API — so audit data is
access-restricted per permissions, not open.

| Event              | Actor                                                                                                                    | Timestamp                 | Source document                                    | Outcome                                                                      | Where recorded / surfaced                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| PO approval/reject | `PurchaseOrder.createdBy` (creator); approver/rejecter is a `MANAGER` by the `@Roles('MANAGER')` guard on approve/reject | `PurchaseOrder.updatedAt` | the purchase order number (`PurchaseOrder.number`) | `status` (APPROVED / REJECTED) with the mandatory `statusReason` on a reject | `PurchaseOrder` row; read via `GET /purchase-orders` and `GET /purchase-orders/{id}`                                                   |
| Goods receipt      | `GoodsReceipt.receivedBy` (a `STAFF` user)                                                                               | `GoodsReceipt.createdAt`  | the receipt number (`GoodsReceipt.number`)         | stock increased; the PO advanced to PARTIALLY_RECEIVED/COMPLETED             | `GoodsReceipt` + one `StockMovement` per line (`type = GOODS_RECEIPT`); read via `GET /goods-receipts` and the movement-history report |
| Sale               | `Sale.createdBy` (a `STAFF` user)                                                                                        | `Sale.confirmedAt`        | the sale document number (`Sale.documentNumber`)   | stock decreased; sale CONFIRMED                                              | `Sale` + one `StockMovement` per line (`type = SALE`); read via `GET /sales` and the movement-history report                           |
| Stock adjustment   | `StockMovement.actor` (a `MANAGER`)                                                                                      | `StockMovement.createdAt` | `"ADJUSTMENT"` (`StockMovement.sourceDocument`)    | signed `qtyChange` applied with the mandatory `reason`                       | `StockMovement` (`type = ADJUSTMENT`, `reason` set); read via `GET /stock/movements` and the movement-history report                   |

Every stock movement additionally snapshots `balanceBefore` and `balanceAfter`, so the ledger is
self-reconciling, and confirmed movements, receipts, and sales are immutable (no update/delete path
exists). Store employees see only their assigned store in the movement-history report; managers see
all stores (RPT-03).

## 6. Test-infrastructure limitations (for a maintainer to address)

These are real gaps in how the guarantees are **enforced in CI**, not gaps in the product behavior
itself. Agents are policy-blocked from editing `.github/**`, and both are test-infrastructure
design decisions, so they are recorded here for a human to apply rather than fixed in the handover.

### 6.1 The CI `check` job has no Postgres service

The Seam-2 real-Postgres integration specs (stood up in ticket #5 and extended by later tickets)
`skipIf` — loudly — when no database is reachable. On CI the `check` job has no Postgres service, so
those specs **skip** rather than run. As a result the database-integrity guarantees — idempotency
replay, concurrency exactly-one-wins, never-negative stock, and unique document numbers — are
enforced **locally and by the `e2e` job**, but are **not machine-enforced on the `check` job on
every pull request yet**.

**Fix (human, `.github/**` is agent-blocked):** add a Postgres service to the `check` job in
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml), mirroring the `e2e` job, so the
integration specs run instead of skip.

### 6.2 e2e worker-startup race (harden the harness; do NOT add retries)

The end-to-end suite has a worker-startup race: with `fullyParallel: true`, workers can issue
requests before the Playwright `webServer` entries (and `baseURL` / `API_PROXY_TARGET`) are fully
ready. The tell is an `Invalid URL` on an `/api/auth/login` call during startup. This has
transiently flaked several unrelated tests across tickets, all tracing to this one root cause rather
than to separate test bugs:

- `apps/e2e/tests/stock-adjustment.e2e.ts`
- `apps/e2e/tests/products.e2e.ts`
- `apps/e2e/tests/purchase-order-transitions.e2e.ts`
- `apps/e2e/tests/stock.e2e.ts`

The repository runs Playwright with **`retries: 0` on purpose** ("a test that passes on retry is a
bug in the test", [`apps/e2e/playwright.config.ts`](../apps/e2e/playwright.config.ts)). The correct
fix is therefore **not** to add retries, but to make the `webServer` readiness authoritative in
`apps/e2e/playwright.config.ts`: gate the web `url` on a real 200, consider raising the 60s
`timeout` and/or adding a readiness poll, and confirm `baseURL` / `API_PROXY_TARGET` resolve before
workers spawn.

**Until it is fixed:** when e2e fails, read the log, confirm the failing test is unrelated to your
diff, re-run the failed e2e job once, and only treat a repeat as a real regression. `apps/e2e` is
not `.github/**`-blocked, but this is test-infra design for a human to schedule, not a mid-ticket
change.

## 7. Pre-UAT decisions owned by RetailOne

Two items are RetailOne decisions for the Solution Design milestone, to flag before UAT (they are
not supplier-decided):

- The agreed NFR-05 test-environment specification (the load-test target environment).
- The NFR-06 supported-browser matrix (viewport 1366px).

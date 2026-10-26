Source of truth: `docs/tors/Retail_ERP_TOR_EN.md` (RetailOne Retail ERP TOR v1.1). This spec is the agreed release baseline. Vocabulary follows the TOR, which serves as the domain glossary (no `GLOSSARY.md`/ADRs exist yet; the domain is greenfield).

## Problem Statement

RetailOne runs a head office and two stores, and keeps product records, purchase orders, and stock balances in separate files. Stock checks are slow and goods get received twice because nothing ties purchasing, receiving, sales, and reporting together. Staff cannot trust the on-hand number they see, managers cannot report across stores, and there is no traceable history of why a stock balance changed.

They need one web application, in Thai, on Asia/Bangkok time, where purchasing creates orders, store staff receive and sell against their own store only, managers approve and adjust, and every stock movement is traceable to the document and the person that caused it — with no duplicate posting, no overselling, and no negative stock.

## Solution

A web ERP (the existing `@erp/web` + `@erp/api` + `@erp/contracts` + `@erp/database` monorepo, extended) delivering the TOR baseline: master data (products, stores, suppliers), an append-only stock-movement ledger, purchase orders with an approval state machine, partial goods receipts, sales, and reports with CSV export. Authentication already exists (cookie-session login, scrypt hashing, global guard) and is extended, not rebuilt. The release adds a four-role model and hard store-scoping so the API — not the UI — enforces who may do what, and where. All integrity guarantees (idempotent confirmation, concurrency safety, atomic post-and-stock, never-negative) are enforced at the database and proven against a real Postgres.

Everything in TOR Section 3, clarifications Q-01..Q-05, and change request CR-01 is out of this release.

## User Stories

### Authentication & access (NFR-01, NFR-02, Section 2)
1. As any user, I want to log in before seeing any data, so that business information is never exposed to anonymous requests.
2. As the system, I want every protected API request to re-check the caller's role and assigned store from the authenticated session, so that hiding UI buttons is never the only control.
3. As a store employee, I want my actions restricted to my assigned store, so that I cannot receive or sell for a store I don't belong to.
4. As a manager, I want cross-store visibility and actions, so that I can approve, adjust, and report across all stores.
5. As the system, I want passwords stored only as scrypt hashes and never logged, so that credentials cannot leak.

### Master data — products, stores, suppliers (MD-01..MD-03)
6. As an administrator, I want to create and edit products with SKU, name, category, unit, selling price, active status, and a per-store reorder threshold, so that catalog and stock settings are maintained in one place.
7. As an administrator, I want SKUs to be unique across the organization and unchangeable once a transaction exists, so that history stays consistent.
8. As an administrator, I want selling prices and reorder thresholds rejected when negative and stock quantities forced to whole numbers, so that invalid data never enters the catalog.
9. As an administrator, I want to deactivate a product while keeping it searchable in historical records, so that discontinued items stay auditable but cannot be added to new documents.
10. As an administrator, I want to maintain store codes/names and supplier codes/names/contacts, so that orders can reference valid suppliers and destination stores.

### Stock balances & movements (INV-01..INV-05, Section 4.3)
11. As any permitted user, I want to search stock by SKU, product name, and store and see quantity, unit, reorder threshold, and low-stock status, so that I can check availability quickly.
12. As the system, I want every stock increase or decrease to record product, store, quantity change, before/after balances, movement type, source document, actor, and timestamp, so that every change is traceable.
13. As the system, I want confirmed movements to be immutable, so that history cannot be edited or deleted.
14. As the system, I want stock balance to equal opening plus successful movements and never go negative, so that the ledger is always reconcilable.
15. As the system, I want document posting and stock update to commit or roll back together, so that I never record a document without its movement or vice versa.
16. As the system, I want concurrent transactions on the same product and store to never lose updates and to validate the authoritative server-side balance at confirm, so that the browser-displayed balance is never trusted.
17. As a manager, I want to increase or decrease stock with a mandatory reason recorded in movement history, so that adjustments are accountable.
18. As the system, I want to reject a manager reduction greater than the available balance, so that adjustments cannot drive stock negative.
19. As an auditor, I want documents to snapshot names/prices at transaction time, so that later master-data edits never rewrite history.

### Purchase orders (PO-01..PO-04)
20. As a purchasing officer, I want to create a draft purchase order with a supplier, destination store, expected receipt date, and at least one product line, so that I can plan a purchase.
21. As a purchasing officer, I want ordered quantities forced positive whole numbers, purchase unit prices non-negative, and duplicate SKUs in one order rejected, so that orders are well-formed.
22. As a purchasing officer, I want to edit a draft and submit it for approval, so that a complete order reaches a manager.
23. As a manager, I want to approve or reject a submitted order with a reason, so that purchasing decisions are controlled and explained.
24. As the system, I want approved lines, quantities, prices, and destination store frozen, so that an approved commitment cannot be quietly changed.
25. As a purchasing officer, I want a rejected order to stay viewable and require a brand-new order to resubmit, so that the rejected record is preserved.
26. As a creator or manager, I want to cancel only a Draft or Pending Approval order with a reason, so that approved/received orders are protected from cancellation.
27. As the system, I want purchase order status to follow Draft → Pending Approval → Approved → Partially Received → Completed, plus Rejected and Cancelled, driven only by valid transitions, so that status can never be set to an illegal value.
28. As the system, I want creating or approving an order to never change stock, so that only receiving moves inventory.

### Goods receipts (GR-01..GR-05)
29. As a store employee, I want to receive only Approved or Partially Received orders for my assigned store, so that I cannot receive for another store.
30. As a store employee, I want the receiving screen to show ordered, previously received, and outstanding quantities per line, so that I know what remains.
31. As a store employee, I want to record partial receipts across multiple deliveries with non-negative whole numbers and at least one line above zero, so that real-world deliveries are handled.
32. As the system, I want cumulative receipts never to exceed ordered quantities and products outside the order never addable, so that receiving stays within the order.
33. As the system, I want confirmation to create a receipt number, increase destination-store stock, record movements, and set the order to Partially Received or Completed, so that receiving updates inventory and order state atomically.
34. As a store employee, I want repeated confirmation clicks, duplicate requests, and retries after network failure to return the original receipt without increasing stock twice, so that flaky networks never double-post.
35. As a store employee, I want a deliberately new receipt still possible, so that a genuine second delivery can be received.
36. As the system, I want concurrent receiving requests to never exceed the order quantity in total, so that two staff cannot over-receive.
37. As the system, I want confirmed receipts viewable but never editable or cancellable, so that receipt history is immutable (reversals are out of scope).
38. As a store employee receiving against an already-Approved order, I want the receipt to proceed even if the product was deactivated after approval, so that an approved commitment is not stranded (Q-02 decision).

### Sales (SAL-01..SAL-04)
39. As a store employee, I want to create a sale for my assigned store using active products and positive whole-number quantities, so that I can record retail sales.
40. As the system, I want the current selling price applied and retained in the document with no user override, so that pricing is controlled and auditable.
41. As the system, I want a draft sale to not reduce stock, so that only confirmation moves inventory.
42. As the system, I want confirmation to validate the latest stock for every line, and if any line is short, reject the whole document and name the affected products, so that partial posting never happens.
43. As the system, I want successful confirmation to generate a document number, record the sale, and decrease stock with movement history in one transaction, so that sale and stock stay consistent.
44. As the system, I want duplicate sale confirmation to not create another sale or deduct stock again, so that retries never double-post.
45. As a store employee, I want confirmed sales viewable but not editable, cancellable, or returnable, so that sales history is immutable in this release.

### Reports & search (RPT-01..RPT-04, Section 6.2)
46. As a manager, I want daily sales reports filtered by date range and store, including only confirmed sales, showing document count, units sold, and total amount, so that I can review trade.
47. As a permitted user, I want stock-on-hand and low-stock reports by store with product search, keeping zero-stock products visible when they match, so that I can spot shortages.
48. As a permitted user, I want movement history filtered by product, store, movement type, and date range, with access to the source document, so that I can trace any change — store employees see their store only, managers see all.
49. As a permitted user, I want to export sales and stock reports as CSV supporting Thai text, with the same filters and permissions as the screen, so that I can work offline.
50. As the system, I want CSV cells that spreadsheets might read as formulas neutralized, so that exports cannot trigger formula injection.
51. As a manager, I want a reporting day to run 00:00:00 inclusive to the next day 00:00:00 exclusive in Asia/Bangkok using the sale confirmation timestamp, so that daily totals land in the correct day.
52. As a permitted user, I want zero totals and a clear empty-state message when nothing matches, so that an empty report is unambiguous.
53. As a permitted user, I want lists paginated and newest-first, with loading/success/error states and actionable Thai error messages, so that screens are usable and explain whether to correct input or retry.

### Seed & operability (Section 8, 7.2)
54. As an acceptance tester, I want a resettable seed producing exactly the Section 8 fixture (stores B01/B02, supplier SUP01, four roled test users, three SKUs with the listed stock/prices, reorder threshold 3, Approved PO-DEMO-001), so that each scenario starts from a known clean state.
55. As RetailOne, I want delivered install/startup/test commands, example config, migrations, seed data, test accounts, API documentation, and a known-limitations register, so that the handover is complete.

## Implementation Decisions

**Scope.** Build the TOR baseline only (MD, INV, PO, GR, SAL, RPT, NFR). TOR Section 3 exclusions, clarifications Q-01..Q-05, and CR-01 (damaged goods) are out. Model data so deferred items aren't painted into a corner (open movement-type enum, explicit PO state machine) but implement none.

**Q-02 resolution (clarification register).** Receiving against an already-Approved purchase order is allowed even if the product was deactivated after approval. MD-02's "inactive products cannot be added to new documents" applies only to creating new POs/sales, not to fulfilling an existing approved line. Record this decision in the clarification register.

**Auth — extend, do not rebuild.** The existing cookie-session login (`erp_session`, HMAC-SHA256 self-contained token, 7-day TTL, `httpOnly`+`sameSite:lax`), scrypt password hashing (`@erp/database`), global `AuthGuard`, and `@Public`/`@Roles`/`@CurrentUser` decorators are the pattern. New protected routes are default-protected `@Implement` handlers. No passport/JWT.

**Role model.** Replace the two-value `Role` enum with four roles mapped 1:1 to the TOR: `ADMIN` (Administrator), `PURCHASING` (Purchasing officer), `STAFF` (Store employee), `MANAGER` (Manager). Update the Prisma enum, the contract `RoleSchema`, and the guard. This breaks the two existing demo users; the reseed handles it.

**Store scoping (net-new).** Add a `Store` entity and a `User`↔`Store` assignment relation. Store employees are pinned to one assigned store; Manager and Administrator are cross-store. Enforce store scope as a per-resource check in each handler (or a reusable scope helper) that derives the store from the authenticated principal — never from the request body. Role says *what* a user may do; store assignment says *where*. This is beyond the current role-only metadata guard.

**Domain model (net-new, greenfield).** Add Prisma models for Store, Supplier, Product (with per-store reorder threshold), StockBalance, StockMovement (append-only ledger), PurchaseOrder + PurchaseOrderLine, GoodsReceipt + GoodsReceiptLine, Sale + SaleLine, and the User↔Store assignment. Follow the established contract-first path: Zod schema + `oc.route(...)` in `@erp/contracts` (registered in `contracts/src/index.ts`), `@Implement(contract.x.y)` Nest controller per feature module, `useQuery`/`useMutation(orpc.x.y...)` on web. Never hand-write request/response types in the apps; derive with `z.infer`.

**Stock as an append-only ledger (INV-02/03).** `StockMovement` rows are immutable and record product, store, quantity change, before/after balances, movement type, source document, actor, timestamp. `StockBalance` is maintained transactionally from movements. Invariant: balance = opening + successful movements, never negative.

**Idempotent confirmation (GR-04, SAL-03).** Goods-receipt and sale confirmation accept a client-supplied idempotency key, unique-constrained in the database. A retry with the same key returns the original document (no second movement); a fresh key creates a new document. Proven by AC-02 and AC-06.

**Concurrency control (INV-04, GR-05, AC-07).** Stock mutation is serialized at the database (row-level lock / `SELECT ... FOR UPDATE` on the balance row, or an equivalent atomic conditional update) inside the posting transaction, re-validating the authoritative balance at confirm. Two concurrent 7-unit sales against stock 10 → exactly one succeeds, final stock 3.

**PO/GR state machine (PO-02/03/04, GR-03).** One authoritative transition table (from-state → to-state → who → required inputs such as reason). Any transition not in the table is rejected server-side. Users never set PO status directly; the receiving action advances Approved → Partially Received → Completed from cumulative receipts. Approved line/qty/price/store are frozen.

**Document & money rules (Section 4.3).** Document numbers unique. Each line snapshots name/price at transaction time. Monetary values two decimal places; line = qty × unit price; document total = sum of lines. No discounts/taxes/valuation/COGS.

**Timezone (Section 2, 6.2) — net-new.** Store all timestamps in UTC using Postgres `timestamptz` (current columns are `TIMESTAMP(3)` without zone — migrate). Convert to Asia/Bangkok only at the reporting-boundary computation and at display. Reporting-day and date-range filters are half-open intervals `[start 00:00 BKK, (end+1) 00:00 BKK)`, keyed on the sale confirmation timestamp. Add a date library (e.g. Luxon/date-fns-tz); none exists yet.

**CSV export (RPT-04).** Neutralize any cell beginning with `=`, `+`, `-`, `@`, tab, or CR (leading apostrophe or equivalent escaping). Emit UTF-8 with BOM so Excel renders Thai. Apply the same filters and permissions as the on-screen report.

**Validation & errors (NFR-04).** Validate in both UI and API (Zod at the contract boundary). Actionable Thai error messages; never expose stack traces or DB details. Error messages state whether to correct input or retry.

**Env/config.** Any new API env var goes in both `apps/api/src/config/env.ts` (Zod) and `.env.example`. Set a real `AUTH_SECRET` outside the workshop. Add `TZ`/timezone config if required by the date approach.

**Seed (Section 8).** Extend the existing idempotent seed to produce exactly the Section 8 fixture: stores B01 Central / B02 Riverside, supplier SUP01, users buyer01 (PURCHASING), staff_b01 (STAFF@B01), staff_b02 (STAFF@B02), manager01 (MANAGER), SKU001/002/003 with listed B01 stock and prices (B02 all zero), reorder threshold 3, and Approved PO-DEMO-001 (20× SKU001 @ 45.00, no receipts). Non-production credentials only. Resettable per scenario.

## Testing Decisions

Good tests assert externally observable behavior at the chosen seam — the document created, the resulting stock balance, the status transition, the rejection and its reason — not internal implementation. The TOR's AC-01..AC-08 are implemented verbatim as acceptance tests, and every MD/INV/PO/GR/SAL/RPT/NFR requirement maps to at least one automated test via a requirement-ID → test traceability matrix (the spec's backbone and the UAT checklist). Section 7.2 is the release definition-of-done.

**Seam 1 — oRPC contract handler (existing, primary).** Exercise handlers via `call(controller.x(), ctx)` from `@orpc/server`, as in `health.controller.spec.ts` / `auth.controller.spec.ts`. Covers Zod input validation, authz (role + store scope), business rules, and the state machine from the caller's perspective. Most of AC-01..AC-08, all negative-authz cases (AC-04: a direct API call by staff_b02 for B01 is rejected with no data change), and illegal state transitions (e.g. cancel an Approved order) live here. Prior art: `auth.guard.spec.ts` for role/permission rejection shape.

**Seam 2 — same handler seam over a real Postgres (new backing, not a new API seam).** The integrity guarantees are database behaviors a mocked `PrismaService` cannot exhibit, so stand up a real-Postgres integration harness (Testcontainers or the compose DB) with per-test reset for: idempotency replay (AC-02, AC-06 — same key returns original, stock unchanged), concurrency exactly-one-wins (AC-07), cumulative-receipt and over-receive rejection (AC-03), atomic post-and-stock + never-negative (INV-03/04), and unique document numbers. Fast mocked unit specs remain for pure logic. This real-DB harness is net-new infrastructure.

**Seam 3 — web component (existing).** jsdom + Testing Library with `mockApi({ 'METHOD /path': ... })` (keyed by method + path without `/api`), as in `login.test.tsx` / `health-status.test.tsx`. Covers screen states (loading/success/error, empty-state message, newest-first pagination), Thai labels, and keyboard operability (NFR-06). Component tests stub the API boundary and do not re-prove Seam 1/2 business rules.

**Seam 4 — scripted load test (new, out-of-process).** For NFR-05, a k6/autocannon-style script against the running API over seeded data at 1,000 products / 10,000 movements / 10 concurrent users, capturing p95 ≤ 2s for search and stock-view endpoints over a continuous 5-minute run (CSV excluded), saved as an evidence artifact.

**Contract-schema tests (existing, cheapest).** Pure Zod `safeParse` valid/invalid cases per schema, as in `contracts/src/auth.test.ts`.

**Timezone & CSV proofs.** A midnight-edge test: a sale confirmed near Bangkok midnight lands in the correct reporting day (Seam 1/2). A CSV test injects a `=cmd`-style value and asserts it is neutralized and Thai text survives (UTF-8 BOM).

Run via `pnpm test` (turbo) / `pnpm --filter <pkg> test`; full gate `pnpm check` (lint, typecheck, test, build) and `pnpm format` before finishing.

## Out of Scope

Per TOR Section 3 and the clarification/change registers, all excluded from this release:

- General ledger, accounts payable/receivable, payroll, manufacturing.
- Tax calculation and tax invoices, discounts, real payments, inventory valuation and cost of goods sold.
- External POS/ERP integration, inter-store transfers, batch and expiry tracking, returns, migration of real business data.
- **Q-01** multi-approver / approval thresholds / delegation (single-manager approval only).
- **Q-03** backdated receiving (system confirmation timestamp only).
- **Q-04** reversals of incorrect receipts or sales.
- **Q-05** different purchase/sales units or barcode scanning (one base unit per SKU).
- **CR-01** damaged-goods-on-receipt (usable vs damaged quantities) — under consideration, not in baseline.
- Cancellation of Approved or partially received orders (PO-04); editing/cancelling confirmed receipts or sales.
- Customer personal data.

These populate the known-limitations register delivered with the handover.

## Further Notes

- **RetailOne decisions for the Solution Design milestone (not supplier-decided):** the agreed NFR-05 test-environment specification, and the NFR-06 supported-browser matrix (viewport 1366px). Flag both before UAT.
- **Acceptance gate (7.3):** all in-scope UAT cases pass; no defect causing incorrect stock, duplicate posting, permission bypass, or data loss may remain.
- **Breaking change:** expanding the role enum and adding store scoping invalidates the two current demo users; the reseed and a migration handle it.
- **Clarification register:** record the Q-02 decision (deactivated-product receiving against an approved PO) with approving stakeholder and the tests that cover it (GR flow + user story 38).
- No `GLOSSARY.md` or ADRs exist; TOR terminology is the working glossary. If the domain model solidifies, capture it via `/domain-modeling`.

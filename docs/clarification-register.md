# Requirements clarification register

Per TOR §10.1, this register records each clarification question's business decision, approving
stakeholder, date, affected requirements, and the tests that cover it. Questions affecting the
current scope are resolved before design approval; future capabilities stay excluded until an
authorised change request is approved.

Questions Q-01, Q-03, Q-04 and Q-05 are resolved as "out of the initial release" in the spec
(GitHub issue #1, "Out of Scope"); they are listed here for completeness. Q-02 affects current
scope and is implemented.

| ID       | Business decision                                                                                                                                                                                                                                                                                                            | Approving stakeholder                                                                                              | Date        | Affected requirements                                   | Associated tests |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------- | ---------------- |
| Q-01     | Single-manager approval only; no multi-approver, thresholds or delegation (PO-03). Deferred.                                                                                                                                                                                                                                 | Manager (approval authority, spec #1 role model)                                                                   | 2026-02     | PO-03                                                   | — (out of scope) |
| **Q-02** | **Receiving against an already-Approved (or Partially Received) purchase order is allowed even when the line's product was deactivated after approval. MD-02's "inactive products cannot be added to new documents" governs the creation of new POs and sales only, not the fulfilment of an existing approved commitment.** | **Manager** (the PO approval authority in the four-role model; spec #1 Q-02 resolution and user stories 4, 23, 38) | **2026-02** | **GR-01..GR-03 (receiving edge), MD-02, user story 38** | **See below**    |
| Q-03     | Backdated receiving not required; the system confirmation timestamp is used. Deferred.                                                                                                                                                                                                                                       | Manager                                                                                                            | 2026-02     | GR timestamps                                           | — (out of scope) |
| Q-04     | Reversals of incorrect receipts or sales remain out of scope. Deferred.                                                                                                                                                                                                                                                      | Manager                                                                                                            | 2026-02     | GR, SAL                                                 | — (out of scope) |
| Q-05     | One base unit per SKU; no purchase/sales unit conversion or barcode scanning. Deferred.                                                                                                                                                                                                                                      | Manager                                                                                                            | 2026-02     | MD-01                                                   | — (out of scope) |

## Q-02 — deactivated product received against an approved PO

**Decision.** An approved purchase order is a prior commitment. Deactivating a product blocks it
from being added to _new_ documents (MD-02), but it does not strand an order that was already
approved while the product was active: a goods receipt against that Approved or Partially Received
order still posts stock and advances the order. A goods receipt is not a new document.

**Source.** GitHub issue #1 (Retail ERP TOR v1.1 baseline), "Q-02 resolution (clarification
register)" and user story 38; TOR §10.1 Q-02. Resolved by GitHub issue #12.

**Approving stakeholder.** The Manager role holds approval authority for purchasing decisions in
this release (spec #1 role model, user stories 4 and 23). The receiving exception for an
already-approved commitment is accepted under that same authority.

**Covering tests.**

- Seam 1 (oRPC handler) — `apps/api/src/goods-receipts/goods-receipts.controller.spec.ts`:
  _"posts stock and advances the order for a product deactivated after approval"_. Pins that the
  receive handler never consults the product's `active` flag.
- Seam 2 (real Postgres) — `apps/api/src/goods-receipts/goods-receipts.integration.spec.ts`:
  _"receives against an approved PO whose product was deactivated after approval: stock 18, one
  receipt, PARTIALLY_RECEIVED (Q-02)"_. Proves the stock rise, the single receipt and movement, and
  the status advance over a real database after the product is deactivated.
- Complementary half (deactivated product still rejected on a _new_ document) —
  `apps/api/src/purchase-orders/purchase-orders.controller.spec.ts`: _"rejects a deactivated
  product with the actionable Thai message"_ (`PRODUCT_INACTIVE_MESSAGE`).
- Demo (Playwright) — `apps/e2e/tests/goods-receipt-deactivated-product.e2e.ts`: deactivate the
  product after its PO is approved, then staff_b01 receives against the approved line and store
  stock increases.

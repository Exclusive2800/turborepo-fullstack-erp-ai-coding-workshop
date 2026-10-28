# API documentation

The API is **contract-first**. Every route, its input, and its output are defined once in
[`packages/contracts`](../packages/contracts) with Zod, the API implements them with
`@Implement(contract.<feature>.<route>)`, and the web calls them through a fully typed client. There
are no hand-written request/response types in the apps.

## Live, generated documentation

The running API serves OpenAPI documentation generated directly from the contract, so it never
drifts from the implemented routes:

- **Swagger UI** — http://localhost:3000/api/docs
- **OpenAPI JSON** — http://localhost:3000/api/openapi.json

Both come from `contract` in [`packages/contracts/src/index.ts`](../packages/contracts/src/index.ts)
via [`apps/api/src/openapi/openapi.controller.ts`](../apps/api/src/openapi/openapi.controller.ts).

## Conventions

- The global prefix is `/api`. The paths below are the contract paths and do **not** repeat the
  prefix; the real URL of, for example, `GET /health` is `GET /api/health`.
- Every route requires a signed-in user via the global `AuthGuard`, **except** those marked
  _public_. `@Roles(...)` restricts a route to the listed roles; store-scoped routes additionally
  derive the caller's store from the authenticated principal, never from the request body.
- List endpoints are paginated (`page`, `pageSize`, max 100) and return newest-first.
- Money is a two-decimal string; timestamps are ISO-8601 UTC strings.
- Error messages are actionable Thai text (Zod at the contract boundary). Stack traces and database
  details are never exposed.

## Routes delivered in this release

### Health

| Method | Path      | Access | Summary                                            |
| ------ | --------- | ------ | -------------------------------------------------- |
| GET    | `/health` | public | Check that the API and the database are reachable. |

### Auth

| Method | Path           | Access   | Summary                                       |
| ------ | -------------- | -------- | --------------------------------------------- |
| POST   | `/auth/login`  | public   | Sign in with email and password.              |
| POST   | `/auth/logout` | public   | Sign out (clears the session cookie).         |
| GET    | `/auth/me`     | public   | The signed-in user, or null.                  |
| GET    | `/auth/whoami` | public\* | The authenticated caller with role and store. |

\* All auth routes are `@Public()` (the whole `AuthController` opts out of the global guard).
`whoami` is reachable without a session but returns `UNAUTHORIZED` from its handler when no user is
signed in.

### Products (master data, MD-01/MD-02)

| Method | Path                                  | Access  | Summary                                                                  |
| ------ | ------------------------------------- | ------- | ------------------------------------------------------------------------ |
| GET    | `/products`                           | any     | List products, newest first (includes deactivated for history search).   |
| POST   | `/products`                           | `ADMIN` | Create a product.                                                        |
| PUT    | `/products/{id}`                      | `ADMIN` | Update a product.                                                        |
| GET    | `/products/{id}/document-eligibility` | any     | Validate a product may be added to a new document (rejects deactivated). |

### Stores (master data, MD-03)

| Method | Path           | Access  | Summary         |
| ------ | -------------- | ------- | --------------- |
| GET    | `/stores`      | any     | List stores.    |
| POST   | `/stores`      | `ADMIN` | Create a store. |
| PUT    | `/stores/{id}` | `ADMIN` | Update a store. |

### Suppliers (master data, MD-03)

| Method | Path              | Access  | Summary                       |
| ------ | ----------------- | ------- | ----------------------------- |
| GET    | `/suppliers`      | any     | List suppliers, newest first. |
| POST   | `/suppliers`      | `ADMIN` | Create a supplier.            |
| PUT    | `/suppliers/{id}` | `ADMIN` | Update a supplier.            |

### Stock (INV-01..INV-05)

| Method | Path                 | Access    | Summary                                                               |
| ------ | -------------------- | --------- | --------------------------------------------------------------------- |
| GET    | `/stock`             | any       | Search stock by SKU, name and store; quantity, threshold, low-stock.  |
| GET    | `/stock/movements`   | any       | List append-only stock-ledger movements, newest first.                |
| POST   | `/stock/adjustments` | `MANAGER` | Manager stock adjustment (increase/decrease) with a mandatory reason. |

### Purchase orders (PO-01..PO-04)

| Method | Path                            | Access            | Summary                                                               |
| ------ | ------------------------------- | ----------------- | --------------------------------------------------------------------- |
| GET    | `/purchase-orders`              | any               | List purchase orders, newest first.                                   |
| GET    | `/purchase-orders/{id}`         | any               | Get one purchase order with its lines.                                |
| POST   | `/purchase-orders`              | `PURCHASING`      | Create a draft purchase order with validated lines.                   |
| POST   | `/purchase-orders/{id}/submit`  | `PURCHASING`      | Submit a draft for approval (DRAFT → PENDING_APPROVAL).               |
| POST   | `/purchase-orders/{id}/approve` | `MANAGER`         | Approve a submitted order (PENDING_APPROVAL → APPROVED).              |
| POST   | `/purchase-orders/{id}/reject`  | `MANAGER`         | Reject a submitted order with a reason (PENDING_APPROVAL → REJECTED). |
| POST   | `/purchase-orders/{id}/cancel`  | creator/`MANAGER` | Cancel a Draft or Pending Approval order with a reason (→ CANCELLED). |

### Goods receipts (GR-01..GR-05)

| Method | Path                                           | Access  | Summary                                                             |
| ------ | ---------------------------------------------- | ------- | ------------------------------------------------------------------- |
| GET    | `/goods-receipts`                              | any     | List goods receipts, newest first.                                  |
| GET    | `/goods-receipts/receivable/{purchaseOrderId}` | any     | A PO with ordered/received/outstanding per line for receiving.      |
| POST   | `/goods-receipts`                              | `STAFF` | Receive against an approved PO (atomic post-and-stock; idempotent). |

### Sales (SAL-01..SAL-04)

| Method | Path                  | Access  | Summary                                                                        |
| ------ | --------------------- | ------- | ------------------------------------------------------------------------------ |
| GET    | `/sales`              | any     | List sales, newest first.                                                      |
| GET    | `/sales/{id}`         | any     | Get one sale with its lines.                                                   |
| POST   | `/sales`              | `STAFF` | Create a draft sale with the current selling price snapshotted onto each line. |
| POST   | `/sales/{id}/confirm` | `STAFF` | Confirm a draft sale (validate stock, deduct, allocate number) atomically.     |

### Reports (RPT-01..RPT-04)

| Method | Path                         | Access    | Summary                                                                         |
| ------ | ---------------------------- | --------- | ------------------------------------------------------------------------------- |
| GET    | `/reports/daily-sales`       | `MANAGER` | Daily sales report over an Asia/Bangkok reporting-day range (confirmed sales).  |
| GET    | `/reports/stock-on-hand`     | any       | Stock-on-hand by store with product search; zero-stock matches stay visible.    |
| GET    | `/reports/low-stock`         | any       | Products whose on-hand is at or below their reorder threshold.                  |
| GET    | `/reports/movement-history`  | any       | Movement history over the ledger with source-document reference, store-scoped.  |
| GET    | `/reports/daily-sales/csv`   | `MANAGER` | Daily sales report as a Thai-safe, formula-injection-safe CSV (same filters).   |
| GET    | `/reports/stock-on-hand/csv` | any       | Stock-on-hand report as a Thai-safe, formula-injection-safe CSV (same filters). |

> "Access: any" means any signed-in user; store-scoped reads (stock search, movement history) still
> narrow a `STAFF` user to their assigned store inside the handler.

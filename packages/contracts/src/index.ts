import { authContract } from './auth.js';
import { healthContract } from './health.js';
import { productContract } from './product.js';
import { purchaseOrderContract } from './purchase-order.js';
import { saleContract } from './sale.js';
import { stockContract } from './stock.js';
import { storeContract } from './store.js';
import { supplierContract } from './supplier.js';

export * from './auth.js';
export * from './errors.js';
export * from './health.js';
export * from './pagination.js';
export * from './product.js';
export * from './purchase-order.js';
export * from './sale.js';
export * from './stock.js';
export * from './store.js';
export * from './supplier.js';

/**
 * The single source of truth for the HTTP API.
 * - apps/api implements it (see `@Implement(...)` in the Nest controllers)
 * - apps/web calls it through a fully typed client (see `src/lib/orpc.ts`)
 *
 * Add new feature contracts here, e.g. `customers: customersContract`.
 */
export const contract = {
  auth: authContract,
  health: healthContract,
  product: productContract,
  purchaseOrder: purchaseOrderContract,
  sale: saleContract,
  stock: stockContract,
  store: storeContract,
  supplier: supplierContract,
};

export type Contract = typeof contract;

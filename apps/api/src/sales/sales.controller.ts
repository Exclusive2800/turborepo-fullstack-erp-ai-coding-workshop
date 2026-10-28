import { Controller } from '@nestjs/common';
import {
  contract,
  NOT_FOUND_MESSAGE,
  PRODUCT_INACTIVE_MESSAGE,
  type Sale,
  type SaleLine,
  type Whoami,
} from '@erp/contracts';
import { Implement, implement, ORPCError } from '@orpc/nest';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { resolveStoreScope } from '../auth/store-scope.js';
import { PrismaService } from '../database/prisma.service.js';

/** A Decimal-like value Prisma returns for a money column. */
interface MoneyValue {
  toFixed: (digits: number) => string;
}

/** A stored sale line row as Prisma returns it (money as Decimal). */
interface SaleLineRow {
  id: string;
  productId: string;
  sku: string;
  productName: string;
  quantity: number;
  unitPrice: MoneyValue;
  lineTotal: MoneyValue;
}

/** A stored sale row with its lines, as Prisma returns it. */
interface SaleRow {
  id: string;
  storeId: string;
  status: Sale['status'];
  total: MoneyValue;
  lines: SaleLineRow[];
  createdAt: Date;
  updatedAt: Date;
}

function serializeLine(row: SaleLineRow): SaleLine {
  return {
    id: row.id,
    productId: row.productId,
    sku: row.sku,
    productName: row.productName,
    quantity: row.quantity,
    unitPrice: row.unitPrice.toFixed(2),
    lineTotal: row.lineTotal.toFixed(2),
  };
}

/** Prisma returns Decimals and Dates; the contract expects money strings and ISO timestamps. */
function serializeSale(row: SaleRow): Sale {
  return {
    id: row.id,
    storeId: row.storeId,
    status: row.status,
    total: row.total.toFixed(2),
    lines: row.lines.map(serializeLine),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Round money to two decimals as an integer count of satang, then back to a fixed string. */
function toMoney(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

@Controller()
export class SalesController {
  constructor(private readonly prisma: PrismaService) {}

  @Implement(contract.sale.list)
  list() {
    return implement(contract.sale.list).handler(async ({ input }) => {
      const { page, pageSize } = input;
      const [rows, total] = await Promise.all([
        this.prisma.sale.findMany({
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: { lines: true },
        }) as Promise<SaleRow[]>,
        this.prisma.sale.count(),
      ]);
      return { items: rows.map(serializeSale), total, page, pageSize };
    });
  }

  @Implement(contract.sale.get)
  get() {
    return implement(contract.sale.get).handler(async ({ input }) => {
      const row = (await this.prisma.sale.findUnique({
        where: { id: input.id },
        include: { lines: true },
      })) as SaleRow | null;
      if (!row) {
        throw new ORPCError('NOT_FOUND', { message: NOT_FOUND_MESSAGE });
      }
      return serializeSale(row);
    });
  }

  /**
   * Create a draft sale (SAL-01, SAL-02). Only a STAFF employee reaches this handler
   * (`@Roles('STAFF')`). The store is derived from the authenticated principal
   * ({@link resolveStoreScope} with no requested store → the staff's assigned store), never from
   * the request body; an unassigned staff user is rejected. Per-line positive-whole-number
   * quantities and the duplicate-product rule are enforced at the contract boundary.
   *
   * Controlled pricing (SAL-02): the handler reads each product's *current* selling price
   * server-side and snapshots it onto the line — the client cannot supply or override a price (the
   * contract strips any `unitPrice` it sends). It additionally rejects a deactivated product (MD-02:
   * active-only for *new* documents) and a missing product, then snapshots each product's name/SKU
   * and computes `lineTotal = quantity × unitPrice` and the sale `total`.
   *
   * A draft sale never touches stock (SAL-03): no `StockMovement` is written and no `StockBalance`
   * changes, and no document number is allocated — only confirmation (#14) moves inventory. The
   * status is always DRAFT; #14 owns the transition to CONFIRMED.
   */
  @Roles('STAFF')
  @Implement(contract.sale.create)
  create(@CurrentUser() user: Whoami) {
    return implement(contract.sale.create).handler(async ({ input }) => {
      // Derive the store from the principal, never the body. A STAFF user gets their assigned store
      // (and is rejected with FORBIDDEN if they are not assigned to one).
      const storeId = resolveStoreScope(user, undefined);

      // Read the current selling price and master fields for each line's product, and reject any
      // deactivated or missing product up front.
      const products = await this.prisma.product.findMany({
        where: { id: { in: input.lines.map((line) => line.productId) } },
        select: { id: true, sku: true, name: true, active: true, sellingPrice: true },
      });
      const productById = new Map(products.map((product) => [product.id, product]));

      const lineData = input.lines.map((line) => {
        const product = productById.get(line.productId);
        if (!product) {
          throw new ORPCError('NOT_FOUND', { message: NOT_FOUND_MESSAGE });
        }
        // MD-02: a deactivated product cannot be added to a *new* document.
        if (!product.active) {
          throw new ORPCError('CONFLICT', { message: PRODUCT_INACTIVE_MESSAGE });
        }
        // SAL-02: the unit price is the product's current selling price, read server-side — never
        // a client-supplied value.
        const unitPrice = product.sellingPrice.toFixed(2);
        const lineTotal = toMoney(line.quantity * Number(unitPrice));
        return {
          productId: line.productId,
          sku: product.sku,
          productName: product.name,
          quantity: line.quantity,
          unitPrice,
          lineTotal,
        };
      });

      const total = toMoney(lineData.reduce((sum, line) => sum + Number(line.lineTotal), 0));

      const row = (await this.prisma.sale.create({
        data: {
          status: 'DRAFT',
          storeId,
          createdById: user.id,
          total,
          lines: { create: lineData },
        },
        include: { lines: true },
      })) as SaleRow;

      return serializeSale(row);
    });
  }
}

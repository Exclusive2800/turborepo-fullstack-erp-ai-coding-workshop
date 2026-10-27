import { Controller } from '@nestjs/common';
import {
  contract,
  NOT_FOUND_MESSAGE,
  PRODUCT_INACTIVE_MESSAGE,
  type PurchaseOrder,
  type PurchaseOrderLine,
  type Whoami,
} from '@erp/contracts';
import { Implement, implement, ORPCError } from '@orpc/nest';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';
import { StockPostingService, type StockTxClient } from '../stock/stock-posting.service.js';

/** A Decimal-like value Prisma returns for a money column. */
interface MoneyValue {
  toFixed: (digits: number) => string;
}

/** A stored PO line row as Prisma returns it (money as Decimal). */
interface PurchaseOrderLineRow {
  id: string;
  productId: string;
  sku: string;
  productName: string;
  quantity: number;
  unitPrice: MoneyValue;
  lineTotal: MoneyValue;
}

/** A stored PO row with its lines, as Prisma returns it. */
interface PurchaseOrderRow {
  id: string;
  number: string;
  status: PurchaseOrder['status'];
  supplierId: string;
  storeId: string;
  expectedReceiptDate: Date;
  total: MoneyValue;
  lines: PurchaseOrderLineRow[];
  createdAt: Date;
  updatedAt: Date;
}

function serializeLine(row: PurchaseOrderLineRow): PurchaseOrderLine {
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
function serializePurchaseOrder(row: PurchaseOrderRow): PurchaseOrder {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    supplierId: row.supplierId,
    storeId: row.storeId,
    expectedReceiptDate: row.expectedReceiptDate.toISOString(),
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
export class PurchaseOrdersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posting: StockPostingService,
  ) {}

  @Implement(contract.purchaseOrder.list)
  list() {
    return implement(contract.purchaseOrder.list).handler(async ({ input }) => {
      const { page, pageSize } = input;
      const [rows, total] = await Promise.all([
        this.prisma.purchaseOrder.findMany({
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: { lines: true },
        }) as Promise<PurchaseOrderRow[]>,
        this.prisma.purchaseOrder.count(),
      ]);
      return { items: rows.map(serializePurchaseOrder), total, page, pageSize };
    });
  }

  @Implement(contract.purchaseOrder.get)
  get() {
    return implement(contract.purchaseOrder.get).handler(async ({ input }) => {
      const row = (await this.prisma.purchaseOrder.findUnique({
        where: { id: input.id },
        include: { lines: true },
      })) as PurchaseOrderRow | null;
      if (!row) {
        throw new ORPCError('NOT_FOUND', { message: NOT_FOUND_MESSAGE });
      }
      return serializePurchaseOrder(row);
    });
  }

  /**
   * Create a draft purchase order (PO-01/PO-02). Only a PURCHASING officer reaches this handler
   * (`@Roles('PURCHASING')`). Per-line quantity/price rules and the duplicate-SKU rule are enforced
   * at the contract boundary; here we additionally reject a deactivated product (MD-02:
   * active-only for *new* documents — the `product.checkForDocument` semantics), snapshot each
   * product's name and unit price onto its line, compute `lineTotal = quantity × unitPrice` and the
   * order `total`, allocate the unique "PO" document number, and persist the order at DRAFT.
   *
   * Creating an order never touches stock (PO-02): no `StockMovement` is written and no
   * `StockBalance` changes — only receiving (#9) moves inventory. The document-number allocation
   * and the order+lines are written in one transaction so a number is never consumed without its
   * order. The status is always DRAFT; #8 owns the transitions that advance it.
   */
  @Roles('PURCHASING')
  @Implement(contract.purchaseOrder.create)
  create(@CurrentUser() user: Whoami) {
    return implement(contract.purchaseOrder.create).handler(async ({ input }) => {
      // Snapshot each line's product name/price and reject any deactivated product up front.
      const products = await this.prisma.product.findMany({
        where: { id: { in: input.lines.map((line) => line.productId) } },
        select: { id: true, sku: true, name: true, active: true },
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
        const lineTotal = toMoney(line.quantity * line.unitPrice);
        return {
          productId: line.productId,
          sku: product.sku,
          productName: product.name,
          quantity: line.quantity,
          unitPrice: toMoney(line.unitPrice),
          lineTotal,
        };
      });

      const total = toMoney(
        lineData.reduce((sum, line) => sum + Number(line.lineTotal), 0),
      );

      const row = await this.prisma.$transaction(async (tx) => {
        const number = await this.posting.allocateDocumentNumber(
          'PO',
          tx as unknown as StockTxClient,
        );
        return (await tx.purchaseOrder.create({
          data: {
            number,
            status: 'DRAFT',
            supplierId: input.supplierId,
            storeId: input.storeId,
            expectedReceiptDate: input.expectedReceiptDate,
            total,
            createdById: user.id,
            lines: { create: lineData },
          },
          include: { lines: true },
        })) as PurchaseOrderRow;
      });

      return serializePurchaseOrder(row);
    });
  }
}

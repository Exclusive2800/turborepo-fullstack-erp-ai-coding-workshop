import { Controller } from '@nestjs/common';
import {
  contract,
  type StockItem,
  type StockMovement,
  type StockMovementListInput,
  type StockSearchInput,
} from '@erp/contracts';
import { Implement, implement } from '@orpc/nest';
import { PrismaService } from '../database/prisma.service.js';

/** A balance row joined to the product and store fields the search result needs. */
interface BalanceRow {
  productId: string;
  storeId: string;
  quantity: number;
  product: { sku: string; name: string; unit: string };
  store: { code: string };
}

/** A ledger row as Prisma returns it (timestamp as a Date). */
interface MovementRow {
  id: string;
  productId: string;
  storeId: string;
  qtyChange: number;
  balanceBefore: number;
  balanceAfter: number;
  type: StockMovement['type'];
  sourceDocument: string;
  actorId: string | null;
  createdAt: Date;
}

function serializeMovement(row: MovementRow): StockMovement {
  return {
    id: row.id,
    productId: row.productId,
    storeId: row.storeId,
    qtyChange: row.qtyChange,
    balanceBefore: row.balanceBefore,
    balanceAfter: row.balanceAfter,
    type: row.type,
    sourceDocument: row.sourceDocument,
    actorId: row.actorId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Build the balance `where` clause from the search filters (INV-01). */
function searchWhere(input: StockSearchInput) {
  const where: Record<string, unknown> = {};
  if (input.storeId) where.storeId = input.storeId;
  if (input.query) {
    where.product = {
      OR: [
        { sku: { contains: input.query, mode: 'insensitive' } },
        { name: { contains: input.query, mode: 'insensitive' } },
      ],
    };
  }
  return where;
}

/** Build the movement-history `where` clause (#19). */
function movementWhere(input: StockMovementListInput) {
  const where: Record<string, unknown> = {};
  if (input.productId) where.productId = input.productId;
  if (input.storeId) where.storeId = input.storeId;
  if (input.type) where.type = input.type;
  return where;
}

@Controller()
export class StockController {
  constructor(private readonly prisma: PrismaService) {}

  @Implement(contract.stock.search)
  search() {
    return implement(contract.stock.search).handler(async ({ input }) => {
      const where = searchWhere(input);
      const { page, pageSize } = input;
      const [rows, total] = await Promise.all([
        this.prisma.stockBalance.findMany({
          where,
          orderBy: [{ store: { code: 'asc' } }, { product: { sku: 'asc' } }],
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: {
            product: { select: { sku: true, name: true, unit: true } },
            store: { select: { code: true } },
          },
        }) as Promise<BalanceRow[]>,
        this.prisma.stockBalance.count({ where }),
      ]);

      // Resolve the per-store reorder threshold for exactly the products/stores in this page.
      const thresholds = (await this.prisma.productStoreThreshold.findMany({
        where: {
          OR: rows.map((r) => ({ productId: r.productId, storeId: r.storeId })),
        },
        select: { productId: true, storeId: true, threshold: true },
      })) as { productId: string; storeId: string; threshold: number }[];
      const thresholdOf = new Map(
        thresholds.map((t) => [`${t.productId}:${t.storeId}`, t.threshold]),
      );

      const items: StockItem[] = rows.map((row) => {
        const threshold = thresholdOf.get(`${row.productId}:${row.storeId}`) ?? null;
        return {
          productId: row.productId,
          sku: row.product.sku,
          name: row.product.name,
          unit: row.product.unit,
          storeId: row.storeId,
          storeCode: row.store.code,
          quantity: row.quantity,
          reorderThreshold: threshold,
          // Low-stock (AC-08) only when a threshold exists and quantity is at or below it.
          lowStock: threshold !== null && row.quantity <= threshold,
        };
      });
      return { items, total, page, pageSize };
    });
  }

  @Implement(contract.stock.movements)
  movements() {
    return implement(contract.stock.movements).handler(async ({ input }) => {
      const where = movementWhere(input);
      const { page, pageSize } = input;
      const [rows, total] = await Promise.all([
        this.prisma.stockMovement.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }) as Promise<MovementRow[]>,
        this.prisma.stockMovement.count({ where }),
      ]);
      return { items: rows.map(serializeMovement), total, page, pageSize };
    });
  }
}

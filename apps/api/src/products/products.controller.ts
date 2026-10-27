import { Controller } from '@nestjs/common';
import {
  contract,
  NOT_FOUND_MESSAGE,
  PRODUCT_INACTIVE_MESSAGE,
  type Product,
  type ProductCreateInput,
  SKU_LOCKED_MESSAGE,
} from '@erp/contracts';
import { Implement, implement, ORPCError } from '@orpc/nest';
import { Roles } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';
import { throwIfDuplicateCode } from '../database/serialize.js';

/** A Prisma Product row with its thresholds relation and Decimal/Date fields. */
interface ProductRow {
  id: string;
  sku: string;
  name: string;
  category: string;
  unit: string;
  sellingPrice: { toFixed: (digits: number) => string };
  active: boolean;
  skuLocked: boolean;
  thresholds: { storeId: string; threshold: number }[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Prisma returns `sellingPrice` as a Decimal and timestamps as `Date`; the contract expects a
 * two-decimal money string and ISO timestamps. One place keeps every product response consistent.
 */
function serializeProduct(row: ProductRow): Product {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    category: row.category,
    unit: row.unit,
    sellingPrice: row.sellingPrice.toFixed(2),
    active: row.active,
    skuLocked: row.skuLocked,
    thresholds: row.thresholds.map((t) => ({ storeId: t.storeId, threshold: t.threshold })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The fields create and update share, minus the SKU (which update guards separately). */
function productData(input: ProductCreateInput) {
  return {
    name: input.name,
    category: input.category,
    unit: input.unit,
    sellingPrice: input.sellingPrice,
    active: input.active,
  };
}

@Controller()
export class ProductsController {
  constructor(private readonly prisma: PrismaService) {}

  @Implement(contract.product.list)
  list() {
    return implement(contract.product.list).handler(async ({ input }) => {
      const { page, pageSize } = input;
      // No `where`: deactivated products remain in the list for historical/record search (MD-02).
      const [rows, total] = await Promise.all([
        this.prisma.product.findMany({
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
          include: { thresholds: true },
        }),
        this.prisma.product.count(),
      ]);
      return { items: rows.map(serializeProduct), total, page, pageSize };
    });
  }

  @Roles('ADMIN')
  @Implement(contract.product.create)
  create() {
    return implement(contract.product.create).handler(async ({ input }) => {
      try {
        const row = await this.prisma.product.create({
          data: {
            sku: input.sku,
            ...productData(input),
            thresholds: {
              create: input.thresholds.map((t) => ({ storeId: t.storeId, threshold: t.threshold })),
            },
          },
          include: { thresholds: true },
        });
        return serializeProduct(row);
      } catch (error) {
        throwIfDuplicateCode(input.sku, error);
      }
    });
  }

  @Roles('ADMIN')
  @Implement(contract.product.update)
  update() {
    return implement(contract.product.update).handler(async ({ input }) => {
      const existing = await this.prisma.product.findUnique({
        where: { id: input.id },
        select: { sku: true, skuLocked: true },
      });
      if (!existing) {
        throw new ORPCError('NOT_FOUND', { message: NOT_FOUND_MESSAGE });
      }
      // MD-01: the SKU cannot change once a transaction has locked it.
      if (existing.skuLocked && input.sku !== existing.sku) {
        throw new ORPCError('CONFLICT', { message: SKU_LOCKED_MESSAGE });
      }
      try {
        const row = await this.prisma.product.update({
          where: { id: input.id },
          data: {
            sku: input.sku,
            ...productData(input),
            // Replace the threshold set so removed stores clear and changed values apply.
            thresholds: {
              deleteMany: {},
              create: input.thresholds.map((t) => ({ storeId: t.storeId, threshold: t.threshold })),
            },
          },
          include: { thresholds: true },
        });
        return serializeProduct(row);
      } catch (error) {
        throwIfDuplicateCode(input.sku, error);
      }
    });
  }

  @Implement(contract.product.checkForDocument)
  checkForDocument() {
    return implement(contract.product.checkForDocument).handler(async ({ input }) => {
      const row = await this.prisma.product.findUnique({
        where: { id: input.id },
        include: { thresholds: true },
      });
      if (!row) {
        throw new ORPCError('NOT_FOUND', { message: NOT_FOUND_MESSAGE });
      }
      // MD-02: a deactivated product cannot be added to a *new* document.
      if (!row.active) {
        throw new ORPCError('CONFLICT', { message: PRODUCT_INACTIVE_MESSAGE });
      }
      return serializeProduct(row);
    });
  }
}

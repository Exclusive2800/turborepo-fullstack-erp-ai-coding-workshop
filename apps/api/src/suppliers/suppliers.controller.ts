import { Controller } from '@nestjs/common';
import { contract, duplicateCodeMessage, type SupplierCreateInput } from '@erp/contracts';
import { Implement, implement, ORPCError } from '@orpc/nest';
import { Roles } from '../auth/auth.decorators.js';
import { isUniqueConstraintError } from '../database/prisma-errors.js';
import { PrismaService } from '../database/prisma.service.js';

type SupplierRow = {
  id: string;
  code: string;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function serialize(row: SupplierRow) {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

/** Optional/empty contact fields become null so the column clears instead of storing "". */
function contactData(input: SupplierCreateInput) {
  const blankToNull = (value: string | undefined) => (value && value.trim() !== '' ? value : null);
  return {
    contactName: blankToNull(input.contactName),
    contactEmail: blankToNull(input.contactEmail),
    contactPhone: blankToNull(input.contactPhone),
  };
}

@Controller()
export class SuppliersController {
  constructor(private readonly prisma: PrismaService) {}

  @Implement(contract.supplier.list)
  list() {
    return implement(contract.supplier.list).handler(async ({ input }) => {
      const { page, pageSize } = input;
      const [rows, total] = await Promise.all([
        this.prisma.supplier.findMany({
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        this.prisma.supplier.count(),
      ]);
      return { items: rows.map(serialize), total, page, pageSize };
    });
  }

  @Roles('ADMIN')
  @Implement(contract.supplier.create)
  create() {
    return implement(contract.supplier.create).handler(async ({ input }) => {
      try {
        const row = await this.prisma.supplier.create({
          data: { code: input.code, name: input.name, ...contactData(input) },
        });
        return serialize(row);
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new ORPCError('CONFLICT', { message: duplicateCodeMessage(input.code) });
        }
        throw error;
      }
    });
  }

  @Roles('ADMIN')
  @Implement(contract.supplier.update)
  update() {
    return implement(contract.supplier.update).handler(async ({ input }) => {
      try {
        const row = await this.prisma.supplier.update({
          where: { id: input.id },
          data: { code: input.code, name: input.name, ...contactData(input) },
        });
        return serialize(row);
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new ORPCError('CONFLICT', { message: duplicateCodeMessage(input.code) });
        }
        throw error;
      }
    });
  }
}

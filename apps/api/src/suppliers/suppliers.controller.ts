import { Controller } from '@nestjs/common';
import { contract, type SupplierCreateInput } from '@erp/contracts';
import { Implement, implement } from '@orpc/nest';
import { Roles } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';
import { serializeTimestamps, throwIfDuplicateCode } from '../database/serialize.js';

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
      return { items: rows.map(serializeTimestamps), total, page, pageSize };
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
        return serializeTimestamps(row);
      } catch (error) {
        throwIfDuplicateCode(input.code, error);
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
        return serializeTimestamps(row);
      } catch (error) {
        throwIfDuplicateCode(input.code, error);
      }
    });
  }
}

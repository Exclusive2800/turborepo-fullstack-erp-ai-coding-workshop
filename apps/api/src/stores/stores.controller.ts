import { Controller } from '@nestjs/common';
import { contract, duplicateCodeMessage } from '@erp/contracts';
import { Implement, implement, ORPCError } from '@orpc/nest';
import { isUniqueConstraintError } from '../database/prisma-errors.js';
import { PrismaService } from '../database/prisma.service.js';
import { Roles } from '../auth/auth.decorators.js';

@Controller()
export class StoresController {
  constructor(private readonly prisma: PrismaService) {}

  @Implement(contract.store.list)
  list() {
    return implement(contract.store.list).handler(async ({ input }) => {
      const { page, pageSize } = input;
      const [rows, total] = await Promise.all([
        this.prisma.store.findMany({
          orderBy: { createdAt: 'desc' },
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        this.prisma.store.count(),
      ]);
      return {
        items: rows.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        })),
        total,
        page,
        pageSize,
      };
    });
  }

  @Roles('ADMIN')
  @Implement(contract.store.create)
  create() {
    return implement(contract.store.create).handler(async ({ input }) => {
      try {
        const row = await this.prisma.store.create({ data: { code: input.code, name: input.name } });
        return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new ORPCError('CONFLICT', { message: duplicateCodeMessage(input.code) });
        }
        throw error;
      }
    });
  }

  @Roles('ADMIN')
  @Implement(contract.store.update)
  update() {
    return implement(contract.store.update).handler(async ({ input }) => {
      try {
        const row = await this.prisma.store.update({
          where: { id: input.id },
          data: { code: input.code, name: input.name },
        });
        return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          throw new ORPCError('CONFLICT', { message: duplicateCodeMessage(input.code) });
        }
        throw error;
      }
    });
  }
}

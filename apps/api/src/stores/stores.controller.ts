import { Controller } from '@nestjs/common';
import { contract } from '@erp/contracts';
import { Implement, implement } from '@orpc/nest';
import { Roles } from '../auth/auth.decorators.js';
import { PrismaService } from '../database/prisma.service.js';
import { serializeTimestamps, throwIfDuplicateCode } from '../database/serialize.js';

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
      return { items: rows.map(serializeTimestamps), total, page, pageSize };
    });
  }

  @Roles('ADMIN')
  @Implement(contract.store.create)
  create() {
    return implement(contract.store.create).handler(async ({ input }) => {
      try {
        const row = await this.prisma.store.create({
          data: { code: input.code, name: input.name },
        });
        return serializeTimestamps(row);
      } catch (error) {
        throwIfDuplicateCode(input.code, error);
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
        return serializeTimestamps(row);
      } catch (error) {
        throwIfDuplicateCode(input.code, error);
      }
    });
  }
}

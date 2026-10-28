import { Module } from '@nestjs/common';
import { SalesController } from './sales.controller.js';

@Module({
  // A draft sale posts no stock and allocates no document number (#13, SAL-03), so this module
  // needs nothing from StockModule — only the global PrismaService. Confirmation (#14) will add the
  // posting dependency when it moves inventory.
  controllers: [SalesController],
})
export class SalesModule {}

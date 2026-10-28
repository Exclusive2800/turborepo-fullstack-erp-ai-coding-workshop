import { Module } from '@nestjs/common';
import { StockModule } from '../stock/stock.module.js';
import { SalesController } from './sales.controller.js';

@Module({
  // StockModule exports the shared StockPostingService used by sale confirmation (#14) to allocate
  // the unique "SAL" document number and post one SALE movement per line inside the confirmation's
  // transaction (atomic post-and-deduct, never-negative). A draft sale (#13) still posts no stock.
  imports: [StockModule],
  controllers: [SalesController],
})
export class SalesModule {}

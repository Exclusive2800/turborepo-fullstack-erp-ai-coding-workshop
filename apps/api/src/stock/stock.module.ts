import { Module } from '@nestjs/common';
import { StockController } from './stock.controller.js';
import { StockPostingService } from './stock-posting.service.js';

@Module({
  controllers: [StockController],
  providers: [StockPostingService],
  // Exported so downstream feature modules (#6 adjustments, #9 goods receipts, #14 sales) post
  // movements and allocate document numbers through the one shared, transaction-safe service.
  exports: [StockPostingService],
})
export class StockModule {}

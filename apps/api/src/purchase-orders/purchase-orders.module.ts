import { Module } from '@nestjs/common';
import { StockModule } from '../stock/stock.module.js';
import { PurchaseOrdersController } from './purchase-orders.controller.js';

@Module({
  // StockModule exports the shared StockPostingService used here only to allocate the unique "PO"
  // document number (Section 4.3). Creating a draft PO posts no stock movement (#7, PO-02).
  imports: [StockModule],
  controllers: [PurchaseOrdersController],
})
export class PurchaseOrdersModule {}

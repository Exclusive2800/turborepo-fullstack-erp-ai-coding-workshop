import { Module } from '@nestjs/common';
import { StockModule } from '../stock/stock.module.js';
import { GoodsReceiptsController } from './goods-receipts.controller.js';

@Module({
  // StockModule exports the shared StockPostingService used here to allocate the unique "GR"
  // document number and to post one GOODS_RECEIPT movement per received line inside the receipt's
  // transaction (#9, GR-03 atomic post-and-stock).
  imports: [StockModule],
  controllers: [GoodsReceiptsController],
})
export class GoodsReceiptsModule {}

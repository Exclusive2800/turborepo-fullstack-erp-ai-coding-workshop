import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ORPCModule } from '@orpc/nest';
import { AuthModule } from './auth/auth.module.js';
import { validateEnv } from './config/env.js';
import { DatabaseModule } from './database/database.module.js';
import { GoodsReceiptsModule } from './goods-receipts/goods-receipts.module.js';
import { HealthModule } from './health/health.module.js';
import { OpenApiModule } from './openapi/openapi.module.js';
import { ProductsModule } from './products/products.module.js';
import { PurchaseOrdersModule } from './purchase-orders/purchase-orders.module.js';
import { SalesModule } from './sales/sales.module.js';
import { StockModule } from './stock/stock.module.js';
import { StoresModule } from './stores/stores.module.js';
import { SuppliersModule } from './suppliers/suppliers.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Repo-root .env (optional). Real environment variables always take precedence.
      envFilePath: ['../../.env'],
      validate: validateEnv,
    }),
    ORPCModule.forRoot({}),
    DatabaseModule,
    AuthModule,
    HealthModule,
    OpenApiModule,
    GoodsReceiptsModule,
    ProductsModule,
    PurchaseOrdersModule,
    SalesModule,
    StockModule,
    StoresModule,
    SuppliersModule,
  ],
})
export class AppModule {}

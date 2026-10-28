import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller.js';

/**
 * Reporting read endpoints (RPT-01..RPT-04). #17 adds the daily sales report; later report tickets
 * (#18 stock-on-hand/low-stock, #19 movement history, #20 CSV export) extend this module. Reads go
 * through the injected PrismaService; no stock posting happens here.
 */
@Module({
  controllers: [ReportsController],
})
export class ReportsModule {}

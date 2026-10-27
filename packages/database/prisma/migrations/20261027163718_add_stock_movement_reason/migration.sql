-- AlterTable: record the mandatory manager reason on an ADJUSTMENT movement (#6, INV-05).
-- NULL for every other movement kind.
ALTER TABLE "StockMovement" ADD COLUMN     "reason" TEXT;

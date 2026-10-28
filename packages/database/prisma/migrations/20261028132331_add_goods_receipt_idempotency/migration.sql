-- AlterTable
ALTER TABLE "GoodsReceipt" ADD COLUMN     "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "GoodsReceipt_idempotencyKey_key" ON "GoodsReceipt"("idempotencyKey");

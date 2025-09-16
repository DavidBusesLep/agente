/*
  Warnings:

  - You are about to alter the column `balance` on the `tenants` table. The data in that column could be lost. The data in that column will be cast from `Decimal` to `Decimal(65,30)`.

*/
-- AlterTable
ALTER TABLE "payments" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "tenants" ALTER COLUMN "balance" SET DATA TYPE DECIMAL(65,30),
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "usage_logs" ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMP(3);

-- RenameIndex
ALTER INDEX "models_provider_name_unique" RENAME TO "models_provider_name_key";

-- RenameIndex
ALTER INDEX "payments_tenant_idx" RENAME TO "payments_tenant_id_idx";

-- RenameIndex
ALTER INDEX "usage_logs_model_idx" RENAME TO "usage_logs_model_id_idx";

-- RenameIndex
ALTER INDEX "usage_logs_tenant_idx" RENAME TO "usage_logs_tenant_id_idx";

-- RenameIndex
ALTER INDEX "users_tenant_email_unique" RENAME TO "users_tenant_id_email_key";

-- RenameIndex
ALTER INDEX "users_tenant_idx" RENAME TO "users_tenant_id_idx";

-- Initial PostgreSQL schema migration

CREATE TABLE "tenants" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "name" TEXT NOT NULL,
  "apikey" TEXT NOT NULL UNIQUE,
  "balance" NUMERIC NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "users" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "password_hash" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "users_tenant_email_unique" ON "users" ("tenant_id", "email");
CREATE INDEX "users_tenant_idx" ON "users" ("tenant_id");

CREATE TABLE "models" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "provider" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "input_cost_per_million" NUMERIC(10,4) NOT NULL,
  "output_cost_per_million" NUMERIC(10,4) NOT NULL,
  "is_active" BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX "models_provider_name_unique" ON "models" ("provider", "name");

CREATE TABLE "usage_logs" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "model_id" TEXT NOT NULL,
  "tokens_in" INTEGER NOT NULL,
  "tokens_out" INTEGER NOT NULL,
  "cost_usd" NUMERIC(12,6) NOT NULL,
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "usage_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "usage_logs_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "models" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "usage_logs_tenant_idx" ON "usage_logs" ("tenant_id");
CREATE INDEX "usage_logs_model_idx" ON "usage_logs" ("model_id");

CREATE TABLE "payments" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "amount" NUMERIC(12,2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "created_at" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "payments_tenant_idx" ON "payments" ("tenant_id");



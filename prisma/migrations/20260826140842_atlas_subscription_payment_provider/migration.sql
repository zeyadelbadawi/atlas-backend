-- CreateEnum
CREATE TYPE "atlas_subscription_payment_provider_status" AS ENUM ('not_configured', 'configured', 'verified', 'disabled');

-- CreateTable
CREATE TABLE "atlas_subscription_payment_provider_config" (
    "id" TEXT NOT NULL,
    "provider_key" TEXT,
    "status" "atlas_subscription_payment_provider_status" NOT NULL DEFAULT 'not_configured',
    "encrypted_config" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "last_tested_at" TIMESTAMP(3),
    "last_test_result" JSONB,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "atlas_subscription_payment_provider_config_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "atlas_subscription_payment_provider_config" ADD CONSTRAINT "atlas_subscription_payment_provider_config_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

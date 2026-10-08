import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261006005016 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "live_confirmation_circuit_state" drop constraint if exists "live_confirmation_circuit_state_integration_key_unique";`);
    this.addSql(`create table if not exists "shipping_selection" ("id" text not null, "cart_id" text not null, "allocation_snapshot_id" text not null, "service_level" text not null, "total_customer_amount" numeric null, "total_provider_amount" numeric null, "currency_code" text not null, "status" text check ("status" in ('active', 'selected', 'superseded', 'expired')) not null default 'active', "expires_at" timestamptz null, "metadata" jsonb null, "raw_total_customer_amount" jsonb null, "raw_total_provider_amount" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "shipping_selection_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_shipping_selection_deleted_at" ON "shipping_selection" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_shipping_selection_cart_id_status" ON "shipping_selection" ("cart_id", "status") WHERE deleted_at IS NULL;`);

    this.addSql(`drop index if exists "IDX_live_confirmation_circuit_state_supplier_id_unique";`);

    this.addSql(`alter table if exists "live_confirmation_circuit_state" rename column "supplier_id" to "integration_key";`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_live_confirmation_circuit_state_integration_key_unique" ON "live_confirmation_circuit_state" ("integration_key") WHERE deleted_at IS NULL;`);

    this.addSql(`alter table if exists "shipping_quote" add column if not exists "package_plan_id" text null, add column if not exists "shipping_selection_id" text null, add column if not exists "carrier_code" text null, add column if not exists "service_code" text null, add column if not exists "provider_amount" numeric null, add column if not exists "estimated_delivery_days" integer null, add column if not exists "raw_provider_amount" jsonb null;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_shipping_quote_shipping_selection_id" ON "shipping_quote" ("shipping_selection_id") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "shipping_selection" cascade;`);

    this.addSql(`drop index if exists "IDX_live_confirmation_circuit_state_integration_key_unique";`);

    this.addSql(`alter table if exists "live_confirmation_circuit_state" rename column "integration_key" to "supplier_id";`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_live_confirmation_circuit_state_supplier_id_unique" ON "live_confirmation_circuit_state" ("supplier_id") WHERE deleted_at IS NULL;`);

    this.addSql(`drop index if exists "IDX_shipping_quote_shipping_selection_id";`);
    this.addSql(`alter table if exists "shipping_quote" drop column if exists "package_plan_id", drop column if exists "shipping_selection_id", drop column if exists "carrier_code", drop column if exists "service_code", drop column if exists "provider_amount", drop column if exists "estimated_delivery_days", drop column if exists "raw_provider_amount";`);
  }

}

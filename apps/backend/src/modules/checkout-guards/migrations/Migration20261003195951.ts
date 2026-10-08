import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261003195951 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "live_confirmation_circuit_state" drop constraint if exists "live_confirmation_circuit_state_supplier_id_unique";`);
    this.addSql(`create table if not exists "checkout_readiness" ("id" text not null, "cart_id" text not null, "status" text check ("status" in ('ready', 'not_ready', 'expired', 'superseded', 'consumed')) not null default 'not_ready', "allocation_snapshot_id" text null, "fingerprint" text not null, "authorized_amount" numeric null, "currency_code" text null, "shipping_quote_id" text null, "supplier_confirmed_at" timestamptz null, "failure_code" text null, "failure_stage" text null, "failure_details" jsonb null, "retryable" boolean null, "requires_reallocation" boolean not null default false, "customer_action_required" boolean not null default false, "expires_at" timestamptz null, "metadata" jsonb null, "raw_authorized_amount" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "checkout_readiness_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_checkout_readiness_deleted_at" ON "checkout_readiness" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_checkout_readiness_cart_id_status" ON "checkout_readiness" ("cart_id", "status") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "live_confirmation_circuit_state" ("id" text not null, "supplier_id" text not null, "opened_at" timestamptz not null, "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "live_confirmation_circuit_state_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_live_confirmation_circuit_state_supplier_id_unique" ON "live_confirmation_circuit_state" ("supplier_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_live_confirmation_circuit_state_deleted_at" ON "live_confirmation_circuit_state" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "shipping_quote" ("id" text not null, "cart_id" text not null, "allocation_snapshot_id" text not null, "carrier_name" text not null, "service_level" text null, "amount" numeric null, "currency_code" text not null, "is_free_shipping" boolean not null default false, "quote_reference" text null, "status" text check ("status" in ('active', 'expired', 'consumed')) not null default 'active', "expires_at" timestamptz null, "metadata" jsonb null, "raw_amount" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "shipping_quote_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_shipping_quote_deleted_at" ON "shipping_quote" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_shipping_quote_cart_id_status" ON "shipping_quote" ("cart_id", "status") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_shipping_quote_allocation_snapshot_id" ON "shipping_quote" ("allocation_snapshot_id") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "checkout_readiness" cascade;`);

    this.addSql(`drop table if exists "live_confirmation_circuit_state" cascade;`);

    this.addSql(`drop table if exists "shipping_quote" cascade;`);
  }

}

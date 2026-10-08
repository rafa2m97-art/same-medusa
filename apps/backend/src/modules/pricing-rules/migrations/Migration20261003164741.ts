import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261003164741 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "supplier_cost" drop constraint if exists "supplier_cost_supplier_product_mapping_id_unique";`);
    this.addSql(`alter table if exists "pricing_state" drop constraint if exists "pricing_state_supplier_product_mapping_id_unique";`);
    this.addSql(`alter table if exists "pricing_policy" drop constraint if exists "pricing_policy_code_unique";`);
    this.addSql(`create table if not exists "pricing_policy" ("id" text not null, "code" text not null, "supplier_id" text null, "currency_code" text not null, "margin_factor" numeric not null, "tax_factor" numeric not null, "rounding_strategy" text check ("rounding_strategy" in ('ceil_to_integer')) not null default 'ceil_to_integer', "status" text check ("status" in ('active', 'superseded')) not null default 'active', "effective_from" timestamptz not null, "metadata" jsonb null, "raw_margin_factor" jsonb not null, "raw_tax_factor" jsonb not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "pricing_policy_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_pricing_policy_code_unique" ON "pricing_policy" ("code") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_pricing_policy_deleted_at" ON "pricing_policy" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_pricing_policy_supplier_id_currency_code_status" ON "pricing_policy" ("supplier_id", "currency_code", "status") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "pricing_state" ("id" text not null, "supplier_product_mapping_id" text not null, "last_classification" text check ("last_classification" in ('ACCEPT', 'REVIEW', 'REJECT')) null, "last_classification_reason" text null, "last_accepted_amount" numeric null, "last_accepted_cost_amount" numeric null, "last_applied_policy_code" text null, "last_evaluated_at" timestamptz null, "last_accepted_at" timestamptz null, "metadata" jsonb null, "raw_last_accepted_amount" jsonb null, "raw_last_accepted_cost_amount" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "pricing_state_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_pricing_state_deleted_at" ON "pricing_state" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_pricing_state_supplier_product_mapping_id_unique" ON "pricing_state" ("supplier_product_mapping_id") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "supplier_cost" ("id" text not null, "supplier_product_mapping_id" text not null, "currency_code" text not null, "amount" numeric not null, "source_sync_run_id" text null, "effective_at" timestamptz not null, "metadata" jsonb null, "raw_amount" jsonb not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "supplier_cost_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_supplier_cost_deleted_at" ON "supplier_cost" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_supplier_cost_supplier_product_mapping_id_unique" ON "supplier_cost" ("supplier_product_mapping_id") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "pricing_policy" cascade;`);

    this.addSql(`drop table if exists "pricing_state" cascade;`);

    this.addSql(`drop table if exists "supplier_cost" cascade;`);
  }

}

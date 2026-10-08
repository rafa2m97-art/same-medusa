import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261003172947 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "pricing_state" drop constraint if exists "pricing_state_variant_id_unique";`);
    this.addSql(`alter table if exists "pricing_policy" add column if not exists "min_change_ratio" numeric not null, add column if not exists "max_change_ratio" numeric not null, add column if not exists "raw_min_change_ratio" jsonb not null, add column if not exists "raw_max_change_ratio" jsonb not null;`);

    this.addSql(`drop index if exists "IDX_pricing_state_supplier_product_mapping_id_unique";`);

    this.addSql(`alter table if exists "pricing_state" add column if not exists "last_strategy" text null, add column if not exists "source_supplier_id" text null, add column if not exists "source_mapping_id" text null, add column if not exists "source_supplier_cost_id" text null;`);
    this.addSql(`alter table if exists "pricing_state" rename column "supplier_product_mapping_id" to "variant_id";`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_pricing_state_variant_id_unique" ON "pricing_state" ("variant_id") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "pricing_policy" drop column if exists "min_change_ratio", drop column if exists "max_change_ratio", drop column if exists "raw_min_change_ratio", drop column if exists "raw_max_change_ratio";`);

    this.addSql(`drop index if exists "IDX_pricing_state_variant_id_unique";`);
    this.addSql(`alter table if exists "pricing_state" drop column if exists "last_strategy", drop column if exists "source_supplier_id", drop column if exists "source_mapping_id", drop column if exists "source_supplier_cost_id";`);

    this.addSql(`alter table if exists "pricing_state" rename column "variant_id" to "supplier_product_mapping_id";`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_pricing_state_supplier_product_mapping_id_unique" ON "pricing_state" ("supplier_product_mapping_id") WHERE deleted_at IS NULL;`);
  }

}

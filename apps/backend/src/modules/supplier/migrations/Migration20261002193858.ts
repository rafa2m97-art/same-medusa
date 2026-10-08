import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261002193858 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "supplier_warehouse" drop constraint if exists "supplier_warehouse_supplier_id_external_code_unique";`);
    this.addSql(`alter table if exists "supplier_product_mapping" drop constraint if exists "supplier_product_mapping_supplier_id_variant_id_unique";`);
    this.addSql(`alter table if exists "supplier" drop constraint if exists "supplier_code_unique";`);
    this.addSql(`create table if not exists "supplier" ("id" text not null, "code" text not null, "name" text not null, "status" text check ("status" in ('active', 'inactive')) not null default 'active', "adapter_key" text not null, "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "supplier_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_supplier_code_unique" ON "supplier" ("code") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_supplier_deleted_at" ON "supplier" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "supplier_product_mapping" ("id" text not null, "variant_id" text not null, "supplier_sku" text not null, "supplier_internal_ref" text null, "status" text check ("status" in ('active', 'inactive')) not null default 'active', "is_quarantined" boolean not null default false, "quarantine_reason" text null, "consecutive_consistent_applies" integer not null default 0, "quarantined_since" timestamptz null, "metadata" jsonb null, "supplier_id" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "supplier_product_mapping_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_supplier_product_mapping_supplier_id" ON "supplier_product_mapping" ("supplier_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_supplier_product_mapping_deleted_at" ON "supplier_product_mapping" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_supplier_product_mapping_supplier_id_variant_id_unique" ON "supplier_product_mapping" ("supplier_id", "variant_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_supplier_product_mapping_supplier_id_supplier_sku" ON "supplier_product_mapping" ("supplier_id", "supplier_sku") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "supplier_warehouse" ("id" text not null, "external_code" text not null, "name" text not null, "status" text check ("status" in ('active', 'inactive')) not null default 'active', "address" text null, "city" text null, "state" text null, "country" text null, "latitude" real null, "longitude" real null, "metadata" jsonb null, "supplier_id" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "supplier_warehouse_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_supplier_warehouse_supplier_id" ON "supplier_warehouse" ("supplier_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_supplier_warehouse_deleted_at" ON "supplier_warehouse" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_supplier_warehouse_supplier_id_external_code_unique" ON "supplier_warehouse" ("supplier_id", "external_code") WHERE deleted_at IS NULL;`);

    this.addSql(`alter table if exists "supplier_product_mapping" add constraint "supplier_product_mapping_supplier_id_foreign" foreign key ("supplier_id") references "supplier" ("id") on update cascade;`);

    this.addSql(`alter table if exists "supplier_warehouse" add constraint "supplier_warehouse_supplier_id_foreign" foreign key ("supplier_id") references "supplier" ("id") on update cascade;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "supplier_product_mapping" drop constraint if exists "supplier_product_mapping_supplier_id_foreign";`);

    this.addSql(`alter table if exists "supplier_warehouse" drop constraint if exists "supplier_warehouse_supplier_id_foreign";`);

    this.addSql(`drop table if exists "supplier" cascade;`);

    this.addSql(`drop table if exists "supplier_product_mapping" cascade;`);

    this.addSql(`drop table if exists "supplier_warehouse" cascade;`);
  }

}

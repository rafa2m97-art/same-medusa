import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261006005015 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "carrier_limit" ("id" text not null, "carrier_code" text not null, "service_code" text null, "max_weight_kg" real not null, "max_length_cm" real not null, "max_width_cm" real not null, "max_height_cm" real not null, "max_girth_cm" real not null, "source" text check ("source" in ('documented', 'empirically_verified')) not null, "verified_at" timestamptz null, "environment" text check ("environment" in ('sandbox', 'production')) null, "notes" text null, "status" text check ("status" in ('active', 'inactive')) not null default 'active', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "carrier_limit_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_carrier_limit_deleted_at" ON "carrier_limit" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_carrier_limit_carrier_code_status" ON "carrier_limit" ("carrier_code", "status") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "package_plan" ("id" text not null, "allocation_snapshot_id" text not null, "supplier_id" text not null, "supplier_warehouse_id" text not null, "status" text check ("status" in ('active', 'superseded', 'unshippable')) not null default 'active', "fingerprint" text not null, "packing_rule_version" text not null, "unshippable_reason" text null, "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "package_plan_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_package_plan_deleted_at" ON "package_plan" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_package_plan_allocation_snapshot_id_supplier_warehouse_id" ON "package_plan" ("allocation_snapshot_id", "supplier_warehouse_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_package_plan_status" ON "package_plan" ("status") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "package_planning_package" ("id" text not null, "sequence_number" integer not null, "weight_kg" real not null, "length_cm" real not null, "width_cm" real not null, "height_cm" real not null, "status" text check ("status" in ('planned', 'unshippable')) not null default 'planned', "unshippable_reason" text null, "metadata" jsonb null, "package_plan_id" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "package_planning_package_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_package_planning_package_package_plan_id" ON "package_planning_package" ("package_plan_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_package_planning_package_deleted_at" ON "package_planning_package" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "package_planning_package_item" ("id" text not null, "allocation_assignment_id" text not null, "variant_id" text not null, "quantity" integer not null, "package_id" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "package_planning_package_item_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_package_planning_package_item_package_id" ON "package_planning_package_item" ("package_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_package_planning_package_item_deleted_at" ON "package_planning_package_item" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`alter table if exists "package_planning_package" add constraint "package_planning_package_package_plan_id_foreign" foreign key ("package_plan_id") references "package_plan" ("id") on update cascade;`);

    this.addSql(`alter table if exists "package_planning_package_item" add constraint "package_planning_package_item_package_id_foreign" foreign key ("package_id") references "package_planning_package" ("id") on update cascade;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "package_planning_package" drop constraint if exists "package_planning_package_package_plan_id_foreign";`);

    this.addSql(`alter table if exists "package_planning_package_item" drop constraint if exists "package_planning_package_item_package_id_foreign";`);

    this.addSql(`drop table if exists "carrier_limit" cascade;`);

    this.addSql(`drop table if exists "package_plan" cascade;`);

    this.addSql(`drop table if exists "package_planning_package" cascade;`);

    this.addSql(`drop table if exists "package_planning_package_item" cascade;`);
  }

}

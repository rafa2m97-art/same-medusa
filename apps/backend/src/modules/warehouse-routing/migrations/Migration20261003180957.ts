import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261003180957 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "routing_rule" drop constraint if exists "routing_rule_destination_state_supplier_id_supplier_warehouse_id_unique";`);
    this.addSql(`create table if not exists "allocation_snapshot" ("id" text not null, "cart_id" text not null, "status" text check ("status" in ('draft', 'active', 'expired', 'superseded', 'consumed', 'invalidated')) not null default 'draft', "strategy" text check ("strategy" in ('single_origin', 'multi_origin', 'unfulfillable')) null, "destination" jsonb null, "input_fingerprint" text not null, "routing_policy_version" text not null, "expires_at" timestamptz null, "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "allocation_snapshot_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_allocation_snapshot_deleted_at" ON "allocation_snapshot" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_allocation_snapshot_cart_id_status" ON "allocation_snapshot" ("cart_id", "status") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "allocation_line" ("id" text not null, "variant_id" text not null, "requested_quantity" integer not null, "allocation_snapshot_id" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "allocation_line_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_allocation_line_allocation_snapshot_id" ON "allocation_line" ("allocation_snapshot_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_allocation_line_deleted_at" ON "allocation_line" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "allocation_assignment" ("id" text not null, "supplier_id" text not null, "supplier_warehouse_id" text not null, "stock_location_id" text not null, "quantity" integer not null, "allocation_line_id" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "allocation_assignment_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_allocation_assignment_allocation_line_id" ON "allocation_assignment" ("allocation_line_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_allocation_assignment_deleted_at" ON "allocation_assignment" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "routing_rule" ("id" text not null, "destination_state" text not null, "supplier_id" text not null, "supplier_warehouse_id" text not null, "priority" integer not null, "status" text check ("status" in ('active', 'inactive')) not null default 'active', "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "routing_rule_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_routing_rule_deleted_at" ON "routing_rule" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_routing_rule_destination_state_supplier_id_supplier_warehouse_id_unique" ON "routing_rule" ("destination_state", "supplier_id", "supplier_warehouse_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_routing_rule_destination_state_status" ON "routing_rule" ("destination_state", "status") WHERE deleted_at IS NULL;`);

    this.addSql(`alter table if exists "allocation_line" add constraint "allocation_line_allocation_snapshot_id_foreign" foreign key ("allocation_snapshot_id") references "allocation_snapshot" ("id") on update cascade;`);

    this.addSql(`alter table if exists "allocation_assignment" add constraint "allocation_assignment_allocation_line_id_foreign" foreign key ("allocation_line_id") references "allocation_line" ("id") on update cascade;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "allocation_line" drop constraint if exists "allocation_line_allocation_snapshot_id_foreign";`);

    this.addSql(`alter table if exists "allocation_assignment" drop constraint if exists "allocation_assignment_allocation_line_id_foreign";`);

    this.addSql(`drop table if exists "allocation_snapshot" cascade;`);

    this.addSql(`drop table if exists "allocation_line" cascade;`);

    this.addSql(`drop table if exists "allocation_assignment" cascade;`);

    this.addSql(`drop table if exists "routing_rule" cascade;`);
  }

}

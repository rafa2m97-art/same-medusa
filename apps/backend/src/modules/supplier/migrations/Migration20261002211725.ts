import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261002211725 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "sync_run" drop constraint if exists "sync_run_supplier_id_source_snapshot_checksum_unique";`);
    this.addSql(`alter table if exists "supplier_product_state" drop constraint if exists "supplier_product_state_supplier_product_mapping_id_unique";`);
    this.addSql(`create table if not exists "supplier_product_state" ("id" text not null, "status" text check ("status" in ('active', 'quarantined')) not null default 'active', "reason" text null, "quarantined_since" timestamptz null, "last_evaluated_at" timestamptz null, "consecutive_consistent_runs" integer not null default 0, "last_supplier_total" integer null, "last_warehouse_total" integer null, "last_conflict_at" timestamptz null, "last_apply_at" timestamptz null, "metadata" jsonb null, "supplier_product_mapping_id" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "supplier_product_state_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_supplier_product_state_supplier_product_mapping_id_unique" ON "supplier_product_state" ("supplier_product_mapping_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_supplier_product_state_deleted_at" ON "supplier_product_state" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "sync_run" ("id" text not null, "mode" text check ("mode" in ('capture_only', 'dry_run', 'apply')) not null default 'dry_run', "status" text check ("status" in ('pending', 'running', 'completed', 'completed_with_conflicts', 'failed', 'cancelled')) not null default 'pending', "started_at" timestamptz null, "completed_at" timestamptz null, "total_rows" integer not null default 0, "applied_count" integer not null default 0, "quarantined_count" integer not null default 0, "skipped_count" integer not null default 0, "error_count" integer not null default 0, "source_snapshot_ref" text null, "source_snapshot_checksum" text null, "correlation_id" text null, "failure_reason" text null, "metadata" jsonb null, "supplier_id" text not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "sync_run_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_sync_run_supplier_id" ON "sync_run" ("supplier_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_sync_run_deleted_at" ON "sync_run" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_sync_run_supplier_id_source_snapshot_checksum_unique" ON "sync_run" ("supplier_id", "source_snapshot_checksum") WHERE source_snapshot_checksum IS NOT NULL AND deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_sync_run_supplier_id_started_at" ON "sync_run" ("supplier_id", "started_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "sync_conflict" ("id" text not null, "supplier_sku" text not null, "conflict_type" text not null, "reason" text not null, "supplier_total" integer null, "warehouse_total" integer null, "warehouse_breakdown" jsonb null, "source_ref" text null, "detected_at" timestamptz not null, "resolved_at" timestamptz null, "resolution" text null, "metadata" jsonb null, "sync_run_id" text not null, "supplier_product_mapping_id" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "sync_conflict_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_sync_conflict_sync_run_id" ON "sync_conflict" ("sync_run_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_sync_conflict_supplier_product_mapping_id" ON "sync_conflict" ("supplier_product_mapping_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_sync_conflict_deleted_at" ON "sync_conflict" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_sync_conflict_sync_run_id_conflict_type" ON "sync_conflict" ("sync_run_id", "conflict_type") WHERE deleted_at IS NULL;`);

    this.addSql(`alter table if exists "supplier_product_state" add constraint "supplier_product_state_supplier_product_mapping_id_foreign" foreign key ("supplier_product_mapping_id") references "supplier_product_mapping" ("id") on update cascade;`);

    this.addSql(`alter table if exists "sync_run" add constraint "sync_run_supplier_id_foreign" foreign key ("supplier_id") references "supplier" ("id") on update cascade;`);

    this.addSql(`alter table if exists "sync_conflict" add constraint "sync_conflict_sync_run_id_foreign" foreign key ("sync_run_id") references "sync_run" ("id") on update cascade;`);
    this.addSql(`alter table if exists "sync_conflict" add constraint "sync_conflict_supplier_product_mapping_id_foreign" foreign key ("supplier_product_mapping_id") references "supplier_product_mapping" ("id") on update cascade on delete set null;`);

    this.addSql(`alter table if exists "supplier_product_mapping" drop column if exists "is_quarantined", drop column if exists "quarantine_reason", drop column if exists "consecutive_consistent_applies", drop column if exists "quarantined_since";`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "sync_conflict" drop constraint if exists "sync_conflict_sync_run_id_foreign";`);

    this.addSql(`drop table if exists "supplier_product_state" cascade;`);

    this.addSql(`drop table if exists "sync_run" cascade;`);

    this.addSql(`drop table if exists "sync_conflict" cascade;`);

    this.addSql(`alter table if exists "supplier_product_mapping" add column if not exists "is_quarantined" boolean not null default false, add column if not exists "quarantine_reason" text null, add column if not exists "consecutive_consistent_applies" integer not null default 0, add column if not exists "quarantined_since" timestamptz null;`);
  }

}

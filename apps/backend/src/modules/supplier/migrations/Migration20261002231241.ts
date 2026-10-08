import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261002231241 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "supplier_product_state" add column if not exists "last_applied_sync_run_id" text null, add column if not exists "last_applied_sync_run_started_at" timestamptz null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "supplier_product_state" drop column if exists "last_applied_sync_run_id", drop column if exists "last_applied_sync_run_started_at";`);
  }

}

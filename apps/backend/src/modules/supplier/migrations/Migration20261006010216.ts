import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261006010216 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "supplier_warehouse" add column if not exists "district" text null, add column if not exists "postal_code" text null, add column if not exists "phone" text null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "supplier_warehouse" drop column if exists "district", drop column if exists "postal_code", drop column if exists "phone";`);
  }

}

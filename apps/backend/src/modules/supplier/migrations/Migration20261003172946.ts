import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261003172946 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "supplier" add column if not exists "is_primary_pricing_source" boolean not null default false;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "supplier" drop column if exists "is_primary_pricing_source";`);
  }

}

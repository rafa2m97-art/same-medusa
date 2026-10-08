import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261006010217 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "package_plan" drop constraint if exists "package_plan_status_check";`);

    this.addSql(`alter table if exists "package_plan" add constraint "package_plan_status_check" check("status" in ('active', 'superseded', 'unshippable', 'missing_data'));`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "package_plan" drop constraint if exists "package_plan_status_check";`);

    this.addSql(`alter table if exists "package_plan" add constraint "package_plan_status_check" check("status" in ('active', 'superseded', 'unshippable'));`);
  }

}

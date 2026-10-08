import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261007020138 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "warehouse_shipment" drop constraint if exists "warehouse_shipment_order_id_supplier_id_supplier_warehouse_id_unique";`);
    this.addSql(`create table if not exists "warehouse_shipment" ("id" text not null, "order_id" text not null, "allocation_snapshot_id" text not null, "supplier_id" text not null, "supplier_warehouse_id" text not null, "stock_location_id" text null, "package_plan_id" text not null, "shipping_selection_id" text not null, "shipping_quote_id" text not null, "carrier_code" text not null, "service_code" text null, "status" text check ("status" in ('PENDING', 'READY_FOR_LABEL', 'LABEL_PURCHASING', 'LABEL_PURCHASED', 'LABEL_FAILED_RETRYABLE', 'LABEL_FAILED_FINAL', 'SUPPLIER_SUBMISSION_PENDING', 'SUPPLIER_SUBMITTING', 'SUPPLIER_ACCEPTED', 'SUPPLIER_FAILED_RETRYABLE', 'SUPPLIER_FAILED_FINAL', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'REQUIRES_MANUAL_REVIEW', 'CANCELLED')) not null default 'PENDING', "tracking_number" text null, "label_reference" text null, "label_format" text check ("label_format" in ('PDF', 'ZPL')) null, "provider_shipment_id" text null, "provider_cost_amount" numeric null, "supplier_order_reference" text null, "supplier_order_status" text null, "label_attempt_count" integer not null default 0, "label_last_error_code" text null, "label_last_error_message" text null, "label_last_attempt_at" timestamptz null, "supplier_attempt_count" integer not null default 0, "supplier_last_error_code" text null, "supplier_last_error_message" text null, "supplier_last_attempt_at" timestamptz null, "requires_manual_review" boolean not null default false, "manual_review_reason" text null, "cancelled_at" timestamptz null, "metadata" jsonb null, "raw_provider_cost_amount" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "warehouse_shipment_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_warehouse_shipment_deleted_at" ON "warehouse_shipment" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_warehouse_shipment_order_id_supplier_id_supplier_warehouse_id_unique" ON "warehouse_shipment" ("order_id", "supplier_id", "supplier_warehouse_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_warehouse_shipment_order_id_status" ON "warehouse_shipment" ("order_id", "status") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "warehouse_shipment_event" ("id" text not null, "warehouse_shipment_id" text not null, "event_type" text not null, "actor" text null, "occurred_at" timestamptz not null, "details" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "warehouse_shipment_event_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_warehouse_shipment_event_deleted_at" ON "warehouse_shipment_event" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_warehouse_shipment_event_warehouse_shipment_id_occurred_at" ON "warehouse_shipment_event" ("warehouse_shipment_id", "occurred_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "warehouse_shipment" cascade;`);

    this.addSql(`drop table if exists "warehouse_shipment_event" cascade;`);
  }

}

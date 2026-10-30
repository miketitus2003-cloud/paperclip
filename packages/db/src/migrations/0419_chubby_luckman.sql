ALTER TABLE "agents" ADD COLUMN "runtime_mutation" jsonb;--> statement-breakpoint
ALTER TABLE "native_run_finalizations" ADD COLUMN "admission_owner" text;--> statement-breakpoint
ALTER TABLE "native_run_finalizations" ADD COLUMN "admission_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "native_run_finalizations" ADD COLUMN "admission_finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN "runtime_mutations" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "native_run_finalizations_pending_admission_idx" ON "native_run_finalizations" USING btree ("company_id","admission_expires_at") WHERE "native_run_finalizations"."admission_owner" is not null and "native_run_finalizations"."admission_finished_at" is null;
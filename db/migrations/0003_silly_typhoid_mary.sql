CREATE TABLE "async_job" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_type" text NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"trace_id" uuid,
	"attempt_count" smallint DEFAULT 0 NOT NULL,
	"max_attempts" smallint DEFAULT 3 NOT NULL,
	"idempotency_key" varchar(128) NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failure_code" varchar(64),
	"failure_detail_safe" varchar(1000),
	CONSTRAINT "async_job_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "async_job_type_check" CHECK ("async_job"."job_type" in ('EXPORT_GENERATE', 'AI_RETRY', 'DEACTIVATION_FINALIZE', 'EXPORT_CLEANUP', 'AUDIT_PARTITION_MAINTAIN')),
	CONSTRAINT "async_job_status_check" CHECK ("async_job"."status" in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'RETRY_SCHEDULED', 'DEAD_LETTER', 'CANCELLED')),
	CONSTRAINT "async_job_attempt_count_nonnegative" CHECK ("async_job"."attempt_count" >= 0),
	CONSTRAINT "async_job_max_attempts_three" CHECK ("async_job"."max_attempts" = 3),
	CONSTRAINT "async_job_attempts_within_limit" CHECK ("async_job"."attempt_count" <= "async_job"."max_attempts")
);
--> statement-breakpoint
CREATE TABLE "deactivation_request" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"status" text DEFAULT 'REQUESTED' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"grace_ends_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"tombstoned_at" timestamp with time zone,
	"reason" varchar(500),
	"retention_hold" boolean DEFAULT false NOT NULL,
	"retention_reason" varchar(500),
	"retention_expected_end_at" timestamp with time zone,
	"tombstone_summary" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "deactivation_request_status_check" CHECK ("deactivation_request"."status" in ('REQUESTED', 'GRACE', 'REVOKED', 'RETENTION_HOLD', 'TOMBSTONING', 'TOMBSTONED')),
	CONSTRAINT "deactivation_request_grace_after_request_check" CHECK ("deactivation_request"."grace_ends_at" > "deactivation_request"."requested_at")
);
--> statement-breakpoint
CREATE TABLE "export_download_token" (
	"id" uuid PRIMARY KEY NOT NULL,
	"export_job_id" uuid NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"issued_to_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "export_download_token_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "export_job" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"status" text DEFAULT 'REQUESTED' NOT NULL,
	"format" text DEFAULT 'CSV' NOT NULL,
	"scope" text DEFAULT 'CORE_BUSINESS_DATA' NOT NULL,
	"snapshot_at" timestamp with time zone,
	"object_key" varchar(512),
	"checksum_sha256" varchar(64),
	"size_bytes" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone,
	"failure_code" varchar(64),
	CONSTRAINT "export_job_id_workspace_id_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "export_job_status_check" CHECK ("export_job"."status" in ('REQUESTED', 'QUEUED', 'GENERATING', 'READY', 'DOWNLOADED', 'FAILED', 'EXPIRED')),
	CONSTRAINT "export_job_format_check" CHECK ("export_job"."format" = 'CSV'),
	CONSTRAINT "export_job_scope_check" CHECK ("export_job"."scope" = 'CORE_BUSINESS_DATA'),
	CONSTRAINT "export_job_size_bytes_nonnegative" CHECK ("export_job"."size_bytes" is null or "export_job"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "idempotency_record" (
	"actor_user_id" uuid NOT NULL,
	"scope" varchar(64) NOT NULL,
	"key" varchar(128) NOT NULL,
	"request_hash" varchar(128) NOT NULL,
	"response_status" smallint NOT NULL,
	"response_body_safe" jsonb NOT NULL,
	"resource_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_record_actor_user_id_scope_key_pk" PRIMARY KEY("actor_user_id","scope","key"),
	CONSTRAINT "idempotency_record_response_status_check" CHECK ("idempotency_record"."response_status" between 100 and 599),
	CONSTRAINT "idempotency_record_expires_after_created_check" CHECK ("idempotency_record"."expires_at" > "idempotency_record"."created_at")
);
--> statement-breakpoint
ALTER TABLE "async_job" ADD CONSTRAINT "async_job_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deactivation_request" ADD CONSTRAINT "deactivation_request_user_workspace_owner_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."workspace"("id","owner_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_download_token" ADD CONSTRAINT "export_download_token_export_job_id_export_job_id_fk" FOREIGN KEY ("export_job_id") REFERENCES "public"."export_job"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_download_token" ADD CONSTRAINT "export_download_token_issued_to_user_id_app_user_id_fk" FOREIGN KEY ("issued_to_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_job" ADD CONSTRAINT "export_job_requester_workspace_owner_fk" FOREIGN KEY ("workspace_id","requested_by_user_id") REFERENCES "public"."workspace"("id","owner_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_record_actor_user_id_app_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "async_job_status_run_after_idx" ON "async_job" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX "async_job_workspace_created_idx" ON "async_job" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deactivation_request_active_user_unique" ON "deactivation_request" USING btree ("user_id") WHERE "deactivation_request"."status" in ('REQUESTED', 'GRACE', 'RETENTION_HOLD', 'TOMBSTONING');--> statement-breakpoint
CREATE INDEX "export_download_token_unconsumed_expires_idx" ON "export_download_token" USING btree ("expires_at") WHERE "export_download_token"."consumed_at" is null;--> statement-breakpoint
CREATE INDEX "export_job_workspace_status_created_idx" ON "export_job" USING btree ("workspace_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "export_job_status_created_idx" ON "export_job" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idempotency_record_expires_idx" ON "idempotency_record" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idempotency_record_actor_scope_created_idx" ON "idempotency_record" USING btree ("actor_user_id","scope","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE FUNCTION validate_export_download_token() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM export_job
		JOIN workspace ON workspace.id = export_job.workspace_id
		WHERE export_job.id = NEW.export_job_id
			AND workspace.owner_user_id = NEW.issued_to_user_id
	) THEN
		RAISE EXCEPTION 'Export token recipient must own the export workspace' USING ERRCODE = '23503';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER export_download_token_validate_recipient BEFORE INSERT OR UPDATE OF export_job_id, issued_to_user_id ON export_download_token FOR EACH ROW EXECUTE FUNCTION validate_export_download_token();--> statement-breakpoint
CREATE FUNCTION validate_async_job_resource() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.job_type IN ('EXPORT_GENERATE', 'EXPORT_CLEANUP') THEN
		IF NOT EXISTS (SELECT 1 FROM export_job WHERE id = NEW.resource_id AND workspace_id = NEW.workspace_id) THEN
			RAISE EXCEPTION 'Export job resource must belong to the async job workspace' USING ERRCODE = '23503';
		END IF;
	ELSIF NEW.job_type = 'AI_RETRY' THEN
		IF NOT EXISTS (SELECT 1 FROM ai_run WHERE id = NEW.resource_id AND workspace_id = NEW.workspace_id) THEN
			RAISE EXCEPTION 'AI run resource must belong to the async job workspace' USING ERRCODE = '23503';
		END IF;
	ELSIF NEW.job_type = 'DEACTIVATION_FINALIZE' THEN
		IF NOT EXISTS (SELECT 1 FROM deactivation_request WHERE id = NEW.resource_id AND workspace_id = NEW.workspace_id) THEN
			RAISE EXCEPTION 'Deactivation resource must belong to the async job workspace' USING ERRCODE = '23503';
		END IF;
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER async_job_validate_resource BEFORE INSERT OR UPDATE OF job_type, resource_id, workspace_id ON async_job FOR EACH ROW EXECUTE FUNCTION validate_async_job_resource();--> statement-breakpoint
CREATE TRIGGER export_job_set_updated_at BEFORE UPDATE ON export_job FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER async_job_set_updated_at BEFORE UPDATE ON async_job FOR EACH ROW EXECUTE FUNCTION set_updated_at();

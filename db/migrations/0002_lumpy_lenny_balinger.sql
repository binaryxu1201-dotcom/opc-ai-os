CREATE TABLE "ai_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"trace_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"status" text DEFAULT 'RECEIVED' NOT NULL,
	"provider_key" varchar(128) NOT NULL,
	"model_version" varchar(128) NOT NULL,
	"prompt_version" varchar(128) NOT NULL,
	"input_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"data_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"consent_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"input_redaction_method" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"input_token_count" integer DEFAULT 0 NOT NULL,
	"output_token_count" integer DEFAULT 0 NOT NULL,
	"estimated_cost_micros" bigint DEFAULT 0 NOT NULL,
	"error_code" varchar(64),
	"failure_detail_safe" varchar(1000),
	"started_at" timestamp with time zone,
	"first_token_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retry_of_run_id" uuid,
	CONSTRAINT "ai_run_trace_id_unique" UNIQUE("trace_id"),
	CONSTRAINT "ai_run_id_workspace_id_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "ai_run_capability_check" CHECK ("ai_run"."capability" in ('TASK_BREAKDOWN', 'DAILY_TOP3')),
	CONSTRAINT "ai_run_status_check" CHECK ("ai_run"."status" in ('RECEIVED', 'PROCESSING', 'WAITING_FOR_INPUT', 'GENERATED', 'TIMED_OUT', 'FAILED', 'DEGRADED')),
	CONSTRAINT "ai_run_input_token_count_nonnegative" CHECK ("ai_run"."input_token_count" >= 0),
	CONSTRAINT "ai_run_output_token_count_nonnegative" CHECK ("ai_run"."output_token_count" >= 0),
	CONSTRAINT "ai_run_estimated_cost_nonnegative" CHECK ("ai_run"."estimated_cost_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ai_suggestion" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ai_run_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"suggestion_type" text NOT NULL,
	"status" text DEFAULT 'GENERATED' NOT NULL,
	"proposed_payload" jsonb NOT NULL,
	"schema_version" varchar(32) NOT NULL,
	"target_project_id" uuid,
	"displayed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"rejected_at" timestamp with time zone,
	"execution_failed_at" timestamp with time zone,
	"failure_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "ai_suggestion_id_workspace_id_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "ai_suggestion_type_check" CHECK ("ai_suggestion"."suggestion_type" in ('TASK_PLAN', 'DAILY_TOP3', 'CLARIFYING_QUESTION', 'NATURAL_LANGUAGE_FALLBACK')),
	CONSTRAINT "ai_suggestion_status_check" CHECK ("ai_suggestion"."status" in ('GENERATED', 'WAITING_CONFIRMATION', 'CONFIRMED', 'REJECTED', 'EXPIRED', 'EXECUTION_FAILED'))
);
--> statement-breakpoint
CREATE TABLE "ai_suggestion_decision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"suggestion_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"edited_payload" jsonb,
	"reason" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_suggestion_decision_check" CHECK ("ai_suggestion_decision"."decision" in ('VIEWED', 'EDITED', 'CONFIRMED', 'REJECTED', 'EXECUTION_FAILED'))
);
--> statement-breakpoint
CREATE TABLE "ai_usage_daily" (
	"workspace_id" uuid NOT NULL,
	"usage_date" date NOT NULL,
	"capability" text NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"estimated_cost_micros" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_daily_workspace_id_usage_date_capability_pk" PRIMARY KEY("workspace_id","usage_date","capability"),
	CONSTRAINT "ai_usage_daily_capability_check" CHECK ("ai_usage_daily"."capability" in ('TASK_BREAKDOWN', 'DAILY_TOP3')),
	CONSTRAINT "ai_usage_daily_request_count_nonnegative" CHECK ("ai_usage_daily"."request_count" >= 0),
	CONSTRAINT "ai_usage_daily_success_count_nonnegative" CHECK ("ai_usage_daily"."success_count" >= 0),
	CONSTRAINT "ai_usage_daily_failure_count_nonnegative" CHECK ("ai_usage_daily"."failure_count" >= 0),
	CONSTRAINT "ai_usage_daily_input_tokens_nonnegative" CHECK ("ai_usage_daily"."input_tokens" >= 0),
	CONSTRAINT "ai_usage_daily_output_tokens_nonnegative" CHECK ("ai_usage_daily"."output_tokens" >= 0),
	CONSTRAINT "ai_usage_daily_cost_nonnegative" CHECK ("ai_usage_daily"."estimated_cost_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE "consent" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"consent_type" text NOT NULL,
	"status" text DEFAULT 'GRANTED' NOT NULL,
	"policy_version" varchar(32) NOT NULL,
	"purpose_version" varchar(32) NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"granted_by_user_id" uuid NOT NULL,
	"revoked_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "consent_workspace_type_unique" UNIQUE("workspace_id","consent_type"),
	CONSTRAINT "consent_type_check" CHECK ("consent"."consent_type" in ('CORE_SERVICE', 'AI_BUSINESS_DATA', 'MODEL_IMPROVEMENT', 'PERSONALIZATION', 'MARKETING')),
	CONSTRAINT "consent_status_check" CHECK ("consent"."status" in ('GRANTED', 'REVOKED'))
);
--> statement-breakpoint
ALTER TABLE "ai_run" ADD CONSTRAINT "ai_run_retry_of_run_id_ai_run_id_fk" FOREIGN KEY ("retry_of_run_id") REFERENCES "public"."ai_run"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_run" ADD CONSTRAINT "ai_run_requester_workspace_owner_fk" FOREIGN KEY ("workspace_id","requested_by_user_id") REFERENCES "public"."workspace"("id","owner_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_suggestion" ADD CONSTRAINT "ai_suggestion_run_workspace_fk" FOREIGN KEY ("ai_run_id","workspace_id") REFERENCES "public"."ai_run"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_suggestion" ADD CONSTRAINT "ai_suggestion_target_project_workspace_fk" FOREIGN KEY ("target_project_id","workspace_id") REFERENCES "public"."project"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_suggestion_decision" ADD CONSTRAINT "ai_suggestion_decision_suggestion_id_ai_suggestion_id_fk" FOREIGN KEY ("suggestion_id") REFERENCES "public"."ai_suggestion"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_suggestion_decision" ADD CONSTRAINT "ai_suggestion_decision_actor_user_id_app_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_daily" ADD CONSTRAINT "ai_usage_daily_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent" ADD CONSTRAINT "consent_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent" ADD CONSTRAINT "consent_granted_by_user_id_app_user_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent" ADD CONSTRAINT "consent_revoked_by_user_id_app_user_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_run_workspace_capability_created_idx" ON "ai_run" USING btree ("workspace_id","capability","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ai_run_status_created_idx" ON "ai_run" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "ai_run_requester_created_idx" ON "ai_run" USING btree ("requested_by_user_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_run_trace_id_idx" ON "ai_run" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "ai_suggestion_workspace_status_created_idx" ON "ai_suggestion" USING btree ("workspace_id","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "ai_suggestion_decision_terminal_unique" ON "ai_suggestion_decision" USING btree ("suggestion_id") WHERE "ai_suggestion_decision"."decision" in ('CONFIRMED', 'REJECTED', 'EXECUTION_FAILED');--> statement-breakpoint
CREATE INDEX "ai_usage_daily_date_capability_idx" ON "ai_usage_daily" USING btree ("usage_date","capability");--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_source_ai_suggestion_workspace_fk" FOREIGN KEY ("source_ai_suggestion_id","workspace_id") REFERENCES "public"."ai_suggestion"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION reject_ai_suggestion_decision_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'ai_suggestion_decision is append-only' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER ai_suggestion_decision_append_only BEFORE UPDATE OR DELETE ON ai_suggestion_decision FOR EACH ROW EXECUTE FUNCTION reject_ai_suggestion_decision_mutation();--> statement-breakpoint
CREATE TRIGGER consent_set_updated_at BEFORE UPDATE ON consent FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER ai_run_set_updated_at BEFORE UPDATE ON ai_run FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER ai_suggestion_set_updated_at BEFORE UPDATE ON ai_suggestion FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER ai_usage_daily_set_updated_at BEFORE UPDATE ON ai_usage_daily FOR EACH ROW EXECUTE FUNCTION set_updated_at();

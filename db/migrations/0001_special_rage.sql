ALTER TABLE "workspace" ADD CONSTRAINT "workspace_id_owner_user_id_unique" UNIQUE("id","owner_user_id");--> statement-breakpoint
CREATE TABLE "customer" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(160) NOT NULL,
	"source" varchar(64) NOT NULL,
	"intent_level" text NOT NULL,
	"stage" text DEFAULT 'LEAD' NOT NULL,
	"next_action" varchar(1000),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"updated_by_user_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "customer_id_workspace_id_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "customer_intent_level_check" CHECK ("customer"."intent_level" in ('LOW', 'MEDIUM', 'HIGH')),
	CONSTRAINT "customer_stage_check" CHECK ("customer"."stage" in ('LEAD', 'CONTACTED', 'QUALIFIED', 'WON', 'LOST'))
);
--> statement-breakpoint
CREATE TABLE "customer_stage_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"customer_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"from_stage" text,
	"to_stage" text NOT NULL,
	"changed_by_user_id" uuid NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" varchar(500),
	CONSTRAINT "customer_stage_history_from_stage_check" CHECK ("customer_stage_history"."from_stage" is null or "customer_stage_history"."from_stage" in ('LEAD', 'CONTACTED', 'QUALIFIED', 'WON', 'LOST')),
	CONSTRAINT "customer_stage_history_to_stage_check" CHECK ("customer_stage_history"."to_stage" in ('LEAD', 'CONTACTED', 'QUALIFIED', 'WON', 'LOST'))
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(160) NOT NULL,
	"objective" varchar(4000) NOT NULL,
	"deliverable" varchar(2000),
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"planned_start_at" date,
	"planned_end_at" date,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"source" text DEFAULT 'MANUAL' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"updated_by_user_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "project_id_workspace_id_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "project_status_check" CHECK ("project"."status" in ('DRAFT', 'IN_PROGRESS', 'PAUSED', 'COMPLETED', 'CANCELLED')),
	CONSTRAINT "project_source_check" CHECK ("project"."source" in ('MANUAL', 'AI_CONFIRMED')),
	CONSTRAINT "project_planned_dates_check" CHECK ("project"."planned_end_at" is null or "project"."planned_start_at" is null or "project"."planned_end_at" >= "project"."planned_start_at")
);
--> statement-breakpoint
CREATE TABLE "task" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"parent_task_id" uuid,
	"depth" smallint NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" varchar(4000),
	"assignee_user_id" uuid NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"due_at" timestamp with time zone,
	"estimated_minutes" integer,
	"is_deferred" boolean DEFAULT false NOT NULL,
	"is_overdue" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'MANUAL' NOT NULL,
	"source_ai_suggestion_id" uuid,
	"source_ai_item_key" varchar(64),
	"completed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"updated_by_user_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "task_id_workspace_id_unique" UNIQUE("id","workspace_id"),
	CONSTRAINT "task_id_workspace_id_project_id_unique" UNIQUE("id","workspace_id","project_id"),
	CONSTRAINT "task_depth_check" CHECK ("task"."depth" between 1 and 3),
	CONSTRAINT "task_parent_depth_check" CHECK ("task"."parent_task_id" is null or "task"."depth" > 1),
	CONSTRAINT "task_estimated_minutes_check" CHECK ("task"."estimated_minutes" is null or "task"."estimated_minutes" > 0),
	CONSTRAINT "task_status_check" CHECK ("task"."status" in ('DRAFT', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED', 'CANCELLED')),
	CONSTRAINT "task_source_check" CHECK ("task"."source" in ('MANUAL', 'AI_CONFIRMED')),
	CONSTRAINT "task_closed_requires_completed_at" CHECK ("task"."status" <> 'CLOSED' or "task"."completed_at" is not null),
	CONSTRAINT "task_ai_source_item_key_check" CHECK ("task"."source" <> 'AI_CONFIRMED' or ("task"."source_ai_suggestion_id" is not null and "task"."source_ai_item_key" is not null))
);
--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_updated_by_user_id_app_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_stage_history" ADD CONSTRAINT "customer_stage_history_changed_by_user_id_app_user_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_stage_history" ADD CONSTRAINT "customer_stage_history_customer_workspace_fk" FOREIGN KEY ("customer_id","workspace_id") REFERENCES "public"."customer"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_updated_by_user_id_app_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_created_by_user_id_app_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_updated_by_user_id_app_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_project_workspace_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."project"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_parent_project_workspace_fk" FOREIGN KEY ("parent_task_id","workspace_id","project_id") REFERENCES "public"."task"("id","workspace_id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_assignee_workspace_owner_fk" FOREIGN KEY ("workspace_id","assignee_user_id") REFERENCES "public"."workspace"("id","owner_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_workspace_stage_updated_idx" ON "customer" USING btree ("workspace_id","stage","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "customer_workspace_intent_idx" ON "customer" USING btree ("workspace_id","intent_level");--> statement-breakpoint
CREATE INDEX "customer_stage_history_customer_changed_idx" ON "customer_stage_history" USING btree ("customer_id","changed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "project_workspace_status_updated_idx" ON "project" USING btree ("workspace_id","status","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "project_workspace_open_planned_end_idx" ON "project" USING btree ("workspace_id","planned_end_at") WHERE "project"."status" in ('DRAFT', 'IN_PROGRESS', 'PAUSED');--> statement-breakpoint
CREATE UNIQUE INDEX "task_source_ai_item_unique" ON "task" USING btree ("source_ai_suggestion_id","source_ai_item_key") WHERE "task"."source_ai_suggestion_id" is not null;--> statement-breakpoint
CREATE INDEX "task_workspace_project_status_due_idx" ON "task" USING btree ("workspace_id","project_id","status","due_at");--> statement-breakpoint
CREATE INDEX "task_workspace_parent_created_idx" ON "task" USING btree ("workspace_id","parent_task_id","created_at");--> statement-breakpoint
CREATE INDEX "task_assignee_status_due_idx" ON "task" USING btree ("assignee_user_id","status","due_at");--> statement-breakpoint
CREATE FUNCTION validate_task_hierarchy() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	parent_depth smallint;
BEGIN
	IF NEW.parent_task_id IS NULL THEN
		IF NEW.depth <> 1 THEN
			RAISE EXCEPTION 'Root task depth must be 1' USING ERRCODE = '23514';
		END IF;
		RETURN NEW;
	END IF;

	SELECT depth INTO parent_depth
	FROM task
	WHERE id = NEW.parent_task_id
		AND workspace_id = NEW.workspace_id
		AND project_id = NEW.project_id;

	IF parent_depth IS NULL THEN
		RAISE EXCEPTION 'Parent task must belong to the same project and workspace' USING ERRCODE = '23503';
	END IF;

	IF NEW.depth <> parent_depth + 1 THEN
		RAISE EXCEPTION 'Child task depth must be exactly parent depth plus one' USING ERRCODE = '23514';
	END IF;

	IF EXISTS (
		SELECT 1
		FROM task
		WHERE parent_task_id = NEW.id
			AND depth <> NEW.depth + 1
	) THEN
		RAISE EXCEPTION 'Task depth change would invalidate an existing child task' USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER task_validate_hierarchy BEFORE INSERT OR UPDATE OF parent_task_id, workspace_id, project_id, depth ON task FOR EACH ROW EXECUTE FUNCTION validate_task_hierarchy();--> statement-breakpoint
CREATE FUNCTION reject_customer_stage_history_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'customer_stage_history is append-only' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER customer_stage_history_append_only BEFORE UPDATE OR DELETE ON customer_stage_history FOR EACH ROW EXECUTE FUNCTION reject_customer_stage_history_mutation();--> statement-breakpoint
CREATE TRIGGER project_set_updated_at BEFORE UPDATE ON project FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER task_set_updated_at BEFORE UPDATE ON task FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER customer_set_updated_at BEFORE UPDATE ON customer FOR EACH ROW EXECUTE FUNCTION set_updated_at();

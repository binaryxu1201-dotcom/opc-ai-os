CREATE EXTENSION IF NOT EXISTS citext;--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" "citext",
	"phone_e164" varchar(32),
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"display_name" varchar(64),
	"email_verified_at" timestamp with time zone,
	"phone_verified_at" timestamp with time zone,
	"tombstoned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "app_user_contact_present" CHECK ("app_user"."email" is not null or "app_user"."phone_e164" is not null),
	CONSTRAINT "app_user_status_check" CHECK ("app_user"."status" in ('ACTIVE', 'DEACTIVATION_REQUESTED', 'DEACTIVATION_GRACE', 'TOMBSTONED', 'LOCKED'))
);
--> statement-breakpoint
CREATE TABLE "credential" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_type" text DEFAULT 'PASSWORD' NOT NULL,
	"secret_hash" text NOT NULL,
	"hash_algorithm" varchar(32) NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	CONSTRAINT "credential_type_check" CHECK ("credential"."credential_type" = 'PASSWORD'),
	CONSTRAINT "credential_status_check" CHECK ("credential"."status" in ('ACTIVE', 'DISABLED'))
);
--> statement-breakpoint
CREATE TABLE "platform_operator" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subject_id" varchar(128) NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"mfa_enrolled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "platform_operator_subject_id_unique" UNIQUE("subject_id"),
	CONSTRAINT "platform_operator_status_check" CHECK ("platform_operator"."status" in ('ACTIVE', 'SUSPENDED', 'REVOKED'))
);
--> statement-breakpoint
CREATE TABLE "platform_operator_role" (
	"operator_id" uuid NOT NULL,
	"role" text NOT NULL,
	"granted_by" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "platform_operator_role_operator_id_role_pk" PRIMARY KEY("operator_id","role"),
	CONSTRAINT "platform_operator_role_check" CHECK ("platform_operator_role"."role" in ('OPERATIONS_READER', 'PLATFORM_ADMIN', 'SECURITY_AUDITOR', 'SUPPORT'))
);
--> statement-breakpoint
CREATE TABLE "profile" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"entrepreneur_stage" varchar(32) NOT NULL,
	"business_goal" varchar(1000) NOT NULL,
	"completed_at" timestamp with time zone,
	"visibility_setting" text DEFAULT 'PRIVATE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "profile_visibility_setting_check" CHECK ("profile"."visibility_setting" = 'PRIVATE'),
	CONSTRAINT "profile_skills_is_array" CHECK (jsonb_typeof("profile"."skills") = 'array'),
	CONSTRAINT "profile_skills_maximum" CHECK (jsonb_array_length("profile"."skills") <= 20)
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"session_family_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"session_version" integer NOT NULL,
	"parent_session_id" uuid,
	"device_summary" varchar(256),
	"ip_prefix_hash" varchar(256),
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"last_authenticated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoke_reason" text,
	CONSTRAINT "session_refresh_token_hash_unique" UNIQUE("refresh_token_hash"),
	CONSTRAINT "session_version_positive" CHECK ("session"."session_version" > 0),
	CONSTRAINT "session_revoke_reason_check" CHECK ("session"."revoke_reason" is null or "session"."revoke_reason" in ('LOGOUT', 'ROTATED', 'REPLAY_DETECTED', 'PASSWORD_CHANGED', 'DEACTIVATED'))
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" varchar(80) NOT NULL,
	"description" varchar(500),
	"rename_count_year" smallint DEFAULT 0 NOT NULL,
	"rename_year" smallint,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "workspace_owner_user_id_unique" UNIQUE("owner_user_id"),
	CONSTRAINT "workspace_rename_count_nonnegative" CHECK ("workspace"."rename_count_year" >= 0),
	CONSTRAINT "workspace_status_check" CHECK ("workspace"."status" in ('ACTIVE', 'DEACTIVATION_REQUESTED', 'READ_ONLY', 'TOMBSTONED'))
);
--> statement-breakpoint
ALTER TABLE "credential" ADD CONSTRAINT "credential_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_operator_role" ADD CONSTRAINT "platform_operator_role_operator_id_platform_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."platform_operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_operator_role" ADD CONSTRAINT "platform_operator_role_granted_by_platform_operator_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."platform_operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile" ADD CONSTRAINT "profile_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_parent_session_id_session_id_fk" FOREIGN KEY ("parent_session_id") REFERENCES "public"."session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace" ADD CONSTRAINT "workspace_owner_user_id_app_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_email_unique" ON "app_user" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "app_user_phone_e164_unique" ON "app_user" USING btree ("phone_e164");--> statement-breakpoint
CREATE UNIQUE INDEX "credential_active_user_type_unique" ON "credential" USING btree ("user_id","credential_type") WHERE "credential"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "session_user_revoked_expires_idx" ON "session" USING btree ("user_id","revoked_at","expires_at");--> statement-breakpoint
CREATE INDEX "session_family_revoked_idx" ON "session" USING btree ("session_family_id","revoked_at");--> statement-breakpoint
CREATE INDEX "session_expires_idx" ON "session" USING btree ("expires_at");--> statement-breakpoint
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	NEW.updated_at = now();
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER app_user_set_updated_at BEFORE UPDATE ON app_user FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER workspace_set_updated_at BEFORE UPDATE ON workspace FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER profile_set_updated_at BEFORE UPDATE ON profile FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER platform_operator_set_updated_at BEFORE UPDATE ON platform_operator FOR EACH ROW EXECUTE FUNCTION set_updated_at();

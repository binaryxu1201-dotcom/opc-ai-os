CREATE TABLE "metric_daily_aggregate" (
	"metric_date" date NOT NULL,
	"metric_name" varchar(64) NOT NULL,
	"dimension_hash" varchar(64) DEFAULT 'none' NOT NULL,
	"value" numeric(18, 4) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "metric_daily_aggregate_metric_date_metric_name_dimension_hash_pk" PRIMARY KEY("metric_date","metric_name","dimension_hash")
);
CREATE INDEX "metric_daily_aggregate_name_date_idx" ON "metric_daily_aggregate" USING btree ("metric_name","metric_date" DESC NULLS LAST);--> statement-breakpoint
CREATE TRIGGER metric_daily_aggregate_set_updated_at BEFORE UPDATE ON metric_daily_aggregate FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
SET ROLE audit_owner;--> statement-breakpoint
CREATE TABLE public.audit_event (
	event_id uuid NOT NULL,
	occurred_at timestamp with time zone NOT NULL,
	actor_type text NOT NULL,
	actor_id uuid,
	workspace_id uuid,
	action varchar(128) NOT NULL,
	resource_type varchar(128) NOT NULL,
	resource_id uuid,
	before_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
	after_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
	summary_truncated boolean NOT NULL DEFAULT false,
	trace_id uuid,
	request_id uuid,
	ai_run_id uuid,
	result text NOT NULL,
	failure_code varchar(64),
	PRIMARY KEY (event_id, occurred_at),
	CONSTRAINT audit_event_actor_type_check CHECK (actor_type IN ('USER', 'ADMIN', 'WORKER', 'SYSTEM')),
	CONSTRAINT audit_event_result_check CHECK (result IN ('SUCCESS', 'DENIED', 'FAILED'))
) PARTITION BY RANGE (occurred_at);--> statement-breakpoint
CREATE INDEX audit_event_workspace_occurred_idx ON public.audit_event USING btree (workspace_id, occurred_at DESC);--> statement-breakpoint
CREATE INDEX audit_event_actor_occurred_idx ON public.audit_event USING btree (actor_id, occurred_at DESC);--> statement-breakpoint
CREATE INDEX audit_event_trace_idx ON public.audit_event USING btree (trace_id);--> statement-breakpoint
CREATE INDEX audit_event_resource_occurred_idx ON public.audit_event USING btree (resource_type, resource_id, occurred_at DESC);--> statement-breakpoint
DO $$
DECLARE
	month_start date := date_trunc('month', current_date)::date;
	partition_start date;
	partition_end date;
BEGIN
	FOR offset_month IN 0..12 LOOP
		partition_start := (month_start + make_interval(months => offset_month))::date;
		partition_end := (month_start + make_interval(months => offset_month + 1))::date;
		EXECUTE format(
			'CREATE TABLE IF NOT EXISTS public.audit_event_y%sm%s PARTITION OF public.audit_event FOR VALUES FROM (%L) TO (%L)',
			to_char(partition_start, 'YYYY'),
			to_char(partition_start, 'MM'),
			partition_start,
			partition_end
		);
	END LOOP;
END;
$$;--> statement-breakpoint
CREATE FUNCTION public.audit_summary_is_safe(summary jsonb) RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
	entry record;
BEGIN
	IF summary IS NULL THEN
		RETURN false;
	END IF;

	CASE jsonb_typeof(summary)
		WHEN 'null', 'boolean', 'number' THEN RETURN true;
		WHEN 'string' THEN RETURN char_length(summary #>> '{}') <= 64;
		WHEN 'array' THEN
			FOR entry IN SELECT value FROM jsonb_array_elements(summary) LOOP
				IF NOT public.audit_summary_is_safe(entry.value) THEN
					RETURN false;
				END IF;
			END LOOP;
			RETURN true;
		WHEN 'object' THEN
			FOR entry IN SELECT key, value FROM jsonb_each(summary) LOOP
				IF entry.key ~* '(password|token|secret|hash|email|phone|ip|address|identity|document|note|prompt|output|content|message|body|text)' THEN
					RETURN false;
				END IF;
				IF NOT public.audit_summary_is_safe(entry.value) THEN
					RETURN false;
				END IF;
			END LOOP;
			RETURN true;
		ELSE RETURN false;
	END CASE;
END;
$$;--> statement-breakpoint
CREATE FUNCTION public.append_audit_event(
	p_event_id uuid,
	p_occurred_at timestamp with time zone,
	p_actor_type text,
	p_actor_id uuid,
	p_workspace_id uuid,
	p_action varchar,
	p_resource_type varchar,
	p_resource_id uuid,
	p_before_summary jsonb,
	p_after_summary jsonb,
	p_summary_truncated boolean,
	p_trace_id uuid,
	p_request_id uuid,
	p_ai_run_id uuid,
	p_result text,
	p_failure_code varchar
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
	IF p_action IS NULL OR char_length(p_action) > 128 OR p_resource_type IS NULL OR char_length(p_resource_type) > 128 THEN
		RAISE EXCEPTION 'Audit action and resource type are required and limited to 128 characters' USING ERRCODE = '22001';
	END IF;
	IF p_failure_code IS NOT NULL AND char_length(p_failure_code) > 64 THEN
		RAISE EXCEPTION 'Audit failure code exceeds 64 characters' USING ERRCODE = '22001';
	END IF;
	IF p_actor_type NOT IN ('USER', 'ADMIN', 'WORKER', 'SYSTEM') OR p_result NOT IN ('SUCCESS', 'DENIED', 'FAILED') THEN
		RAISE EXCEPTION 'Invalid audit actor type or result' USING ERRCODE = '22023';
	END IF;
	IF NOT public.audit_summary_is_safe(p_before_summary) OR NOT public.audit_summary_is_safe(p_after_summary) THEN
		RAISE EXCEPTION 'Audit summary contains unsupported or sensitive data' USING ERRCODE = '22023';
	END IF;

	INSERT INTO public.audit_event (
		event_id, occurred_at, actor_type, actor_id, workspace_id, action, resource_type, resource_id,
		before_summary, after_summary, summary_truncated, trace_id, request_id, ai_run_id, result, failure_code
	) VALUES (
		p_event_id, p_occurred_at, p_actor_type, p_actor_id, p_workspace_id, p_action, p_resource_type, p_resource_id,
		p_before_summary, p_after_summary, p_summary_truncated, p_trace_id, p_request_id, p_ai_run_id, p_result, p_failure_code
	);
END;
$$;--> statement-breakpoint
CREATE FUNCTION public.reject_audit_event_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
	RAISE EXCEPTION 'audit_event is append-only' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER audit_event_append_only BEFORE UPDATE OR DELETE ON public.audit_event FOR EACH ROW EXECUTE FUNCTION public.reject_audit_event_mutation();--> statement-breakpoint
REVOKE ALL ON TABLE public.audit_event FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.audit_summary_is_safe(jsonb) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.append_audit_event(uuid, timestamp with time zone, text, uuid, uuid, varchar, varchar, uuid, jsonb, jsonb, boolean, uuid, uuid, uuid, text, varchar) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reject_audit_event_mutation() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.append_audit_event(uuid, timestamp with time zone, text, uuid, uuid, varchar, varchar, uuid, jsonb, jsonb, boolean, uuid, uuid, uuid, text, varchar) TO opc_ai_os_dev;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM opc_ai_os_dev;--> statement-breakpoint
REVOKE audit_owner FROM opc_ai_os_dev;

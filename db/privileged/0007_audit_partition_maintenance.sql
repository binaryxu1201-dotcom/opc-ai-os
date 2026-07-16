-- Execute only with the controlled audit_owner deployment role after the
-- ordinary 0007_system_audit_partition_jobs migration has been applied.
-- This script must never run as the application or Worker database role.
SET ROLE audit_owner;

CREATE FUNCTION public.maintain_audit_partitions() RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.maintain_audit_partitions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.maintain_audit_partitions() TO opc_ai_os_dev;
RESET ROLE;

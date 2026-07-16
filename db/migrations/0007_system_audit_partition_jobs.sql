ALTER TABLE async_job ALTER COLUMN workspace_id DROP NOT NULL;--> statement-breakpoint
ALTER TABLE async_job DROP CONSTRAINT async_job_workspace_id_workspace_id_fk;--> statement-breakpoint
ALTER TABLE async_job ADD CONSTRAINT async_job_workspace_id_workspace_id_fk FOREIGN KEY (workspace_id) REFERENCES public.workspace(id) ON DELETE NO ACTION ON UPDATE NO ACTION;--> statement-breakpoint
ALTER TABLE async_job ADD CONSTRAINT async_job_scope_check CHECK (
  (job_type = 'AUDIT_PARTITION_MAINTAIN' AND resource_type = 'system' AND workspace_id IS NULL)
  OR (job_type <> 'AUDIT_PARTITION_MAINTAIN' AND workspace_id IS NOT NULL)
);

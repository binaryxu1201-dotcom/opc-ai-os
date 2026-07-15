import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  check,
  bigint,
  boolean,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar
} from "drizzle-orm/pg-core";

const citext = customType<{ data: string }>({
  dataType: () => "citext"
});

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
};

export const appUser = pgTable(
  "app_user",
  {
    id: uuid("id").primaryKey(),
    email: citext("email"),
    phoneE164: varchar("phone_e164", { length: 32 }),
    status: text("status").notNull().default("ACTIVE"),
    displayName: varchar("display_name", { length: 64 }),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    phoneVerifiedAt: timestamp("phone_verified_at", { withTimezone: true }),
    tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }),
    ...timestamps,
    version: integer("version").notNull().default(1),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`)
  },
  (table) => [
    uniqueIndex("app_user_email_unique").on(table.email),
    uniqueIndex("app_user_phone_e164_unique").on(table.phoneE164),
    check("app_user_contact_present", sql`${table.email} is not null or ${table.phoneE164} is not null`),
    check(
      "app_user_status_check",
      sql`${table.status} in ('ACTIVE', 'DEACTIVATION_REQUESTED', 'DEACTIVATION_GRACE', 'TOMBSTONED', 'LOCKED')`
    )
  ]
);

export const credential = pgTable(
  "credential",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => appUser.id),
    credentialType: text("credential_type").notNull().default("PASSWORD"),
    secretHash: text("secret_hash").notNull(),
    hashAlgorithm: varchar("hash_algorithm", { length: 32 }).notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
    status: text("status").notNull().default("ACTIVE")
  },
  (table) => [
    uniqueIndex("credential_active_user_type_unique")
      .on(table.userId, table.credentialType)
      .where(sql`${table.status} = 'ACTIVE'`),
    check("credential_type_check", sql`${table.credentialType} = 'PASSWORD'`),
    check("credential_status_check", sql`${table.status} in ('ACTIVE', 'DISABLED')`)
  ]
);

export const session = pgTable(
  "session",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => appUser.id),
    sessionFamilyId: uuid("session_family_id").notNull(),
    refreshTokenHash: text("refresh_token_hash").notNull().unique(),
    sessionVersion: integer("session_version").notNull(),
    parentSessionId: uuid("parent_session_id").references((): AnyPgColumn => session.id),
    deviceSummary: varchar("device_summary", { length: 256 }),
    ipPrefixHash: varchar("ip_prefix_hash", { length: 256 }),
    issuedAt: timestamp("issued_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    lastAuthenticatedAt: timestamp("last_authenticated_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokeReason: text("revoke_reason")
  },
  (table) => [
    index("session_user_revoked_expires_idx").on(table.userId, table.revokedAt, table.expiresAt),
    index("session_family_revoked_idx").on(table.sessionFamilyId, table.revokedAt),
    index("session_expires_idx").on(table.expiresAt),
    check("session_version_positive", sql`${table.sessionVersion} > 0`),
    check(
      "session_revoke_reason_check",
      sql`${table.revokeReason} is null or ${table.revokeReason} in ('LOGOUT', 'ROTATED', 'REPLAY_DETECTED', 'PASSWORD_CHANGED', 'DEACTIVATED')`
    )
  ]
);

export const workspace = pgTable(
  "workspace",
  {
    id: uuid("id").primaryKey(),
    ownerUserId: uuid("owner_user_id").notNull().unique().references(() => appUser.id),
    name: varchar("name", { length: 80 }).notNull(),
    description: varchar("description", { length: 500 }),
    renameCountYear: smallint("rename_count_year").notNull().default(0),
    renameYear: smallint("rename_year"),
    status: text("status").notNull().default("ACTIVE"),
    ...timestamps,
    version: integer("version").notNull().default(1)
  },
  (table) => [
    unique("workspace_id_owner_user_id_unique").on(table.id, table.ownerUserId),
    check("workspace_rename_count_nonnegative", sql`${table.renameCountYear} >= 0`),
    check("workspace_status_check", sql`${table.status} in ('ACTIVE', 'DEACTIVATION_REQUESTED', 'READ_ONLY', 'TOMBSTONED')`)
  ]
);

export const project = pgTable(
  "project",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspace.id),
    name: varchar("name", { length: 160 }).notNull(),
    objective: varchar("objective", { length: 4000 }).notNull(),
    deliverable: varchar("deliverable", { length: 2000 }),
    status: text("status").notNull().default("DRAFT"),
    plannedStartAt: date("planned_start_at"),
    plannedEndAt: date("planned_end_at"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    source: text("source").notNull().default("MANUAL"),
    ...timestamps,
    createdByUserId: uuid("created_by_user_id").notNull().references(() => appUser.id),
    updatedByUserId: uuid("updated_by_user_id").notNull().references(() => appUser.id),
    version: integer("version").notNull().default(1)
  },
  (table) => [
    unique("project_id_workspace_id_unique").on(table.id, table.workspaceId),
    index("project_workspace_status_updated_idx").on(table.workspaceId, table.status, table.updatedAt.desc()),
    index("project_workspace_open_planned_end_idx")
      .on(table.workspaceId, table.plannedEndAt)
      .where(sql`${table.status} in ('DRAFT', 'IN_PROGRESS', 'PAUSED')`),
    check("project_status_check", sql`${table.status} in ('DRAFT', 'IN_PROGRESS', 'PAUSED', 'COMPLETED', 'CANCELLED')`),
    check("project_source_check", sql`${table.source} in ('MANUAL', 'AI_CONFIRMED')`),
    check(
      "project_planned_dates_check",
      sql`${table.plannedEndAt} is null or ${table.plannedStartAt} is null or ${table.plannedEndAt} >= ${table.plannedStartAt}`
    )
  ]
);

export const task = pgTable(
  "task",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    parentTaskId: uuid("parent_task_id"),
    depth: smallint("depth").notNull(),
    title: varchar("title", { length: 200 }).notNull(),
    description: varchar("description", { length: 4000 }),
    assigneeUserId: uuid("assignee_user_id").notNull(),
    status: text("status").notNull().default("DRAFT"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    estimatedMinutes: integer("estimated_minutes"),
    isDeferred: boolean("is_deferred").notNull().default(false),
    isOverdue: boolean("is_overdue").notNull().default(false),
    source: text("source").notNull().default("MANUAL"),
    sourceAiSuggestionId: uuid("source_ai_suggestion_id"),
    sourceAiItemKey: varchar("source_ai_item_key", { length: 64 }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    ...timestamps,
    createdByUserId: uuid("created_by_user_id").notNull().references(() => appUser.id),
    updatedByUserId: uuid("updated_by_user_id").notNull().references(() => appUser.id),
    version: integer("version").notNull().default(1)
  },
  (table) => [
    unique("task_id_workspace_id_unique").on(table.id, table.workspaceId),
    unique("task_id_workspace_id_project_id_unique").on(table.id, table.workspaceId, table.projectId),
    uniqueIndex("task_source_ai_item_unique")
      .on(table.sourceAiSuggestionId, table.sourceAiItemKey)
      .where(sql`${table.sourceAiSuggestionId} is not null`),
    foreignKey({
      name: "task_project_workspace_fk",
      columns: [table.projectId, table.workspaceId],
      foreignColumns: [project.id, project.workspaceId]
    }),
    foreignKey({
      name: "task_parent_project_workspace_fk",
      columns: [table.parentTaskId, table.workspaceId, table.projectId],
      foreignColumns: [table.id, table.workspaceId, table.projectId]
    }),
    foreignKey({
      name: "task_assignee_workspace_owner_fk",
      columns: [table.workspaceId, table.assigneeUserId],
      foreignColumns: [workspace.id, workspace.ownerUserId]
    }),
    index("task_workspace_project_status_due_idx").on(table.workspaceId, table.projectId, table.status, table.dueAt),
    index("task_workspace_parent_created_idx").on(table.workspaceId, table.parentTaskId, table.createdAt),
    index("task_assignee_status_due_idx").on(table.assigneeUserId, table.status, table.dueAt),
    check("task_depth_check", sql`${table.depth} between 1 and 3`),
    check("task_parent_depth_check", sql`${table.parentTaskId} is null or ${table.depth} > 1`),
    check("task_estimated_minutes_check", sql`${table.estimatedMinutes} is null or ${table.estimatedMinutes} > 0`),
    check(
      "task_status_check",
      sql`${table.status} in ('DRAFT', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'CLOSED', 'CANCELLED')`
    ),
    check("task_source_check", sql`${table.source} in ('MANUAL', 'AI_CONFIRMED')`),
    check("task_closed_requires_completed_at", sql`${table.status} <> 'CLOSED' or ${table.completedAt} is not null`),
    check(
      "task_ai_source_item_key_check",
      sql`${table.source} <> 'AI_CONFIRMED' or (${table.sourceAiSuggestionId} is not null and ${table.sourceAiItemKey} is not null)`
    )
  ]
);

export const customer = pgTable(
  "customer",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspace.id),
    name: varchar("name", { length: 160 }).notNull(),
    source: varchar("source", { length: 64 }).notNull(),
    intentLevel: text("intent_level").notNull(),
    stage: text("stage").notNull().default("LEAD"),
    nextAction: varchar("next_action", { length: 1000 }),
    notes: text("notes"),
    ...timestamps,
    createdByUserId: uuid("created_by_user_id").notNull().references(() => appUser.id),
    updatedByUserId: uuid("updated_by_user_id").notNull().references(() => appUser.id),
    version: integer("version").notNull().default(1)
  },
  (table) => [
    unique("customer_id_workspace_id_unique").on(table.id, table.workspaceId),
    index("customer_workspace_stage_updated_idx").on(table.workspaceId, table.stage, table.updatedAt.desc()),
    index("customer_workspace_intent_idx").on(table.workspaceId, table.intentLevel),
    check("customer_intent_level_check", sql`${table.intentLevel} in ('LOW', 'MEDIUM', 'HIGH')`),
    check("customer_stage_check", sql`${table.stage} in ('LEAD', 'CONTACTED', 'QUALIFIED', 'WON', 'LOST')`)
  ]
);

export const customerStageHistory = pgTable(
  "customer_stage_history",
  {
    id: uuid("id").primaryKey(),
    customerId: uuid("customer_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    fromStage: text("from_stage"),
    toStage: text("to_stage").notNull(),
    changedByUserId: uuid("changed_by_user_id").notNull().references(() => appUser.id),
    changedAt: timestamp("changed_at", { withTimezone: true }).defaultNow().notNull(),
    reason: varchar("reason", { length: 500 })
  },
  (table) => [
    foreignKey({
      name: "customer_stage_history_customer_workspace_fk",
      columns: [table.customerId, table.workspaceId],
      foreignColumns: [customer.id, customer.workspaceId]
    }),
    index("customer_stage_history_customer_changed_idx").on(table.customerId, table.changedAt.desc()),
    check(
      "customer_stage_history_from_stage_check",
      sql`${table.fromStage} is null or ${table.fromStage} in ('LEAD', 'CONTACTED', 'QUALIFIED', 'WON', 'LOST')`
    ),
    check("customer_stage_history_to_stage_check", sql`${table.toStage} in ('LEAD', 'CONTACTED', 'QUALIFIED', 'WON', 'LOST')`)
  ]
);

export const consent = pgTable(
  "consent",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspace.id),
    consentType: text("consent_type").notNull(),
    status: text("status").notNull().default("GRANTED"),
    policyVersion: varchar("policy_version", { length: 32 }).notNull(),
    purposeVersion: varchar("purpose_version", { length: 32 }).notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    grantedByUserId: uuid("granted_by_user_id").notNull().references(() => appUser.id),
    revokedByUserId: uuid("revoked_by_user_id").references(() => appUser.id),
    ...timestamps,
    version: integer("version").notNull().default(1)
  },
  (table) => [
    unique("consent_workspace_type_unique").on(table.workspaceId, table.consentType),
    check(
      "consent_type_check",
      sql`${table.consentType} in ('CORE_SERVICE', 'AI_BUSINESS_DATA', 'MODEL_IMPROVEMENT', 'PERSONALIZATION', 'MARKETING')`
    ),
    check("consent_status_check", sql`${table.status} in ('GRANTED', 'REVOKED')`)
  ]
);

export const aiRun = pgTable(
  "ai_run",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    requestedByUserId: uuid("requested_by_user_id").notNull(),
    traceId: uuid("trace_id").notNull().unique(),
    capability: text("capability").notNull(),
    status: text("status").notNull().default("RECEIVED"),
    providerKey: varchar("provider_key", { length: 128 }).notNull(),
    modelVersion: varchar("model_version", { length: 128 }).notNull(),
    promptVersion: varchar("prompt_version", { length: 128 }).notNull(),
    inputSummary: jsonb("input_summary").notNull().default(sql`'{}'::jsonb`),
    outputSummary: jsonb("output_summary").notNull().default(sql`'{}'::jsonb`),
    dataCategories: jsonb("data_categories").notNull().default(sql`'[]'::jsonb`),
    consentEvidence: jsonb("consent_evidence").notNull().default(sql`'[]'::jsonb`),
    inputRedactionMethod: jsonb("input_redaction_method").notNull().default(sql`'{}'::jsonb`),
    inputTokenCount: integer("input_token_count").notNull().default(0),
    outputTokenCount: integer("output_token_count").notNull().default(0),
    estimatedCostMicros: bigint("estimated_cost_micros", { mode: "number" }).notNull().default(0),
    errorCode: varchar("error_code", { length: 64 }),
    failureDetailSafe: varchar("failure_detail_safe", { length: 1000 }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    firstTokenAt: timestamp("first_token_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps,
    retryOfRunId: uuid("retry_of_run_id").references((): AnyPgColumn => aiRun.id)
  },
  (table) => [
    unique("ai_run_id_workspace_id_unique").on(table.id, table.workspaceId),
    foreignKey({
      name: "ai_run_requester_workspace_owner_fk",
      columns: [table.workspaceId, table.requestedByUserId],
      foreignColumns: [workspace.id, workspace.ownerUserId]
    }),
    index("ai_run_workspace_capability_created_idx").on(table.workspaceId, table.capability, table.createdAt.desc()),
    index("ai_run_status_created_idx").on(table.status, table.createdAt),
    index("ai_run_requester_created_idx").on(table.requestedByUserId, table.createdAt),
    index("ai_run_trace_id_idx").on(table.traceId),
    check("ai_run_capability_check", sql`${table.capability} in ('TASK_BREAKDOWN', 'DAILY_TOP3')`),
    check(
      "ai_run_status_check",
      sql`${table.status} in ('RECEIVED', 'PROCESSING', 'WAITING_FOR_INPUT', 'GENERATED', 'TIMED_OUT', 'FAILED', 'DEGRADED')`
    ),
    check("ai_run_input_token_count_nonnegative", sql`${table.inputTokenCount} >= 0`),
    check("ai_run_output_token_count_nonnegative", sql`${table.outputTokenCount} >= 0`),
    check("ai_run_estimated_cost_nonnegative", sql`${table.estimatedCostMicros} >= 0`)
  ]
);

export const aiSuggestion = pgTable(
  "ai_suggestion",
  {
    id: uuid("id").primaryKey(),
    aiRunId: uuid("ai_run_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    suggestionType: text("suggestion_type").notNull(),
    status: text("status").notNull().default("GENERATED"),
    proposedPayload: jsonb("proposed_payload").notNull(),
    schemaVersion: varchar("schema_version", { length: 32 }).notNull(),
    targetProjectId: uuid("target_project_id"),
    displayedAt: timestamp("displayed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    executionFailedAt: timestamp("execution_failed_at", { withTimezone: true }),
    failureCode: varchar("failure_code", { length: 64 }),
    ...timestamps,
    version: integer("version").notNull().default(1)
  },
  (table) => [
    unique("ai_suggestion_id_workspace_id_unique").on(table.id, table.workspaceId),
    foreignKey({
      name: "ai_suggestion_run_workspace_fk",
      columns: [table.aiRunId, table.workspaceId],
      foreignColumns: [aiRun.id, aiRun.workspaceId]
    }),
    foreignKey({
      name: "ai_suggestion_target_project_workspace_fk",
      columns: [table.targetProjectId, table.workspaceId],
      foreignColumns: [project.id, project.workspaceId]
    }),
    index("ai_suggestion_workspace_status_created_idx").on(table.workspaceId, table.status, table.createdAt.desc()),
    check(
      "ai_suggestion_type_check",
      sql`${table.suggestionType} in ('TASK_PLAN', 'DAILY_TOP3', 'CLARIFYING_QUESTION', 'NATURAL_LANGUAGE_FALLBACK')`
    ),
    check(
      "ai_suggestion_status_check",
      sql`${table.status} in ('GENERATED', 'WAITING_CONFIRMATION', 'CONFIRMED', 'REJECTED', 'EXPIRED', 'EXECUTION_FAILED')`
    )
  ]
);

export const aiSuggestionDecision = pgTable(
  "ai_suggestion_decision",
  {
    id: uuid("id").primaryKey(),
    suggestionId: uuid("suggestion_id").notNull().references(() => aiSuggestion.id),
    decision: text("decision").notNull(),
    actorUserId: uuid("actor_user_id").notNull().references(() => appUser.id),
    editedPayload: jsonb("edited_payload"),
    reason: varchar("reason", { length: 500 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex("ai_suggestion_decision_terminal_unique")
      .on(table.suggestionId)
      .where(sql`${table.decision} in ('CONFIRMED', 'REJECTED', 'EXECUTION_FAILED')`),
    check("ai_suggestion_decision_check", sql`${table.decision} in ('VIEWED', 'EDITED', 'CONFIRMED', 'REJECTED', 'EXECUTION_FAILED')`)
  ]
);

export const aiUsageDaily = pgTable(
  "ai_usage_daily",
  {
    workspaceId: uuid("workspace_id").notNull().references(() => workspace.id),
    usageDate: date("usage_date").notNull(),
    capability: text("capability").notNull(),
    requestCount: integer("request_count").notNull().default(0),
    successCount: integer("success_count").notNull().default(0),
    failureCount: integer("failure_count").notNull().default(0),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    estimatedCostMicros: bigint("estimated_cost_micros", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.usageDate, table.capability] }),
    index("ai_usage_daily_date_capability_idx").on(table.usageDate, table.capability),
    check("ai_usage_daily_capability_check", sql`${table.capability} in ('TASK_BREAKDOWN', 'DAILY_TOP3')`),
    check("ai_usage_daily_request_count_nonnegative", sql`${table.requestCount} >= 0`),
    check("ai_usage_daily_success_count_nonnegative", sql`${table.successCount} >= 0`),
    check("ai_usage_daily_failure_count_nonnegative", sql`${table.failureCount} >= 0`),
    check("ai_usage_daily_input_tokens_nonnegative", sql`${table.inputTokens} >= 0`),
    check("ai_usage_daily_output_tokens_nonnegative", sql`${table.outputTokens} >= 0`),
    check("ai_usage_daily_cost_nonnegative", sql`${table.estimatedCostMicros} >= 0`)
  ]
);

export const exportJob = pgTable(
  "export_job",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    requestedByUserId: uuid("requested_by_user_id").notNull(),
    status: text("status").notNull().default("REQUESTED"),
    format: text("format").notNull().default("CSV"),
    scope: text("scope").notNull().default("CORE_BUSINESS_DATA"),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }),
    objectKey: varchar("object_key", { length: 512 }),
    checksumSha256: varchar("checksum_sha256", { length: 64 }),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    ...timestamps,
    version: integer("version").notNull().default(1),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    failureCode: varchar("failure_code", { length: 64 })
  },
  (table) => [
    unique("export_job_id_workspace_id_unique").on(table.id, table.workspaceId),
    foreignKey({
      name: "export_job_requester_workspace_owner_fk",
      columns: [table.workspaceId, table.requestedByUserId],
      foreignColumns: [workspace.id, workspace.ownerUserId]
    }),
    index("export_job_workspace_status_created_idx").on(table.workspaceId, table.status, table.createdAt.desc()),
    index("export_job_status_created_idx").on(table.status, table.createdAt),
    check(
      "export_job_status_check",
      sql`${table.status} in ('REQUESTED', 'QUEUED', 'GENERATING', 'READY', 'DOWNLOADED', 'FAILED', 'EXPIRED')`
    ),
    check("export_job_format_check", sql`${table.format} = 'CSV'`),
    check("export_job_scope_check", sql`${table.scope} = 'CORE_BUSINESS_DATA'`),
    check("export_job_size_bytes_nonnegative", sql`${table.sizeBytes} is null or ${table.sizeBytes} >= 0`)
  ]
);

export const exportDownloadToken = pgTable(
  "export_download_token",
  {
    id: uuid("id").primaryKey(),
    exportJobId: uuid("export_job_id").notNull().references(() => exportJob.id),
    tokenHash: varchar("token_hash", { length: 128 }).notNull().unique(),
    issuedToUserId: uuid("issued_to_user_id").notNull().references(() => appUser.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true })
  },
  (table) => [
    index("export_download_token_unconsumed_expires_idx")
      .on(table.expiresAt)
      .where(sql`${table.consumedAt} is null`)
  ]
);

export const deactivationRequest = pgTable(
  "deactivation_request",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    status: text("status").notNull().default("REQUESTED"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
    graceEndsAt: timestamp("grace_ends_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }),
    reason: varchar("reason", { length: 500 }),
    retentionHold: boolean("retention_hold").notNull().default(false),
    retentionReason: varchar("retention_reason", { length: 500 }),
    retentionExpectedEndAt: timestamp("retention_expected_end_at", { withTimezone: true }),
    tombstoneSummary: jsonb("tombstone_summary"),
    version: integer("version").notNull().default(1)
  },
  (table) => [
    foreignKey({
      name: "deactivation_request_user_workspace_owner_fk",
      columns: [table.workspaceId, table.userId],
      foreignColumns: [workspace.id, workspace.ownerUserId]
    }),
    uniqueIndex("deactivation_request_active_user_unique")
      .on(table.userId)
      .where(sql`${table.status} in ('REQUESTED', 'GRACE', 'RETENTION_HOLD', 'TOMBSTONING')`),
    check(
      "deactivation_request_status_check",
      sql`${table.status} in ('REQUESTED', 'GRACE', 'REVOKED', 'RETENTION_HOLD', 'TOMBSTONING', 'TOMBSTONED')`
    ),
    check("deactivation_request_grace_after_request_check", sql`${table.graceEndsAt} > ${table.requestedAt}`)
  ]
);

export const asyncJob = pgTable(
  "async_job",
  {
    id: uuid("id").primaryKey(),
    jobType: text("job_type").notNull(),
    status: text("status").notNull().default("QUEUED"),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspace.id),
    traceId: uuid("trace_id"),
    attemptCount: smallint("attempt_count").notNull().default(0),
    maxAttempts: smallint("max_attempts").notNull().default(3),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull().unique(),
    runAfter: timestamp("run_after", { withTimezone: true }).defaultNow().notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps,
    failureCode: varchar("failure_code", { length: 64 }),
    failureDetailSafe: varchar("failure_detail_safe", { length: 1000 })
  },
  (table) => [
    index("async_job_status_run_after_idx").on(table.status, table.runAfter),
    index("async_job_workspace_created_idx").on(table.workspaceId, table.createdAt),
    check(
      "async_job_type_check",
      sql`${table.jobType} in ('EXPORT_GENERATE', 'AI_RETRY', 'DEACTIVATION_FINALIZE', 'EXPORT_CLEANUP', 'AUDIT_PARTITION_MAINTAIN')`
    ),
    check(
      "async_job_status_check",
      sql`${table.status} in ('QUEUED', 'RUNNING', 'SUCCEEDED', 'RETRY_SCHEDULED', 'DEAD_LETTER', 'CANCELLED')`
    ),
    check("async_job_attempt_count_nonnegative", sql`${table.attemptCount} >= 0`),
    check("async_job_max_attempts_three", sql`${table.maxAttempts} = 3`),
    check("async_job_attempts_within_limit", sql`${table.attemptCount} <= ${table.maxAttempts}`)
  ]
);

export const idempotencyRecord = pgTable(
  "idempotency_record",
  {
    actorUserId: uuid("actor_user_id").notNull().references(() => appUser.id),
    scope: varchar("scope", { length: 64 }).notNull(),
    key: varchar("key", { length: 128 }).notNull(),
    requestHash: varchar("request_hash", { length: 128 }).notNull(),
    responseStatus: smallint("response_status").notNull(),
    responseBodySafe: jsonb("response_body_safe").notNull(),
    resourceId: uuid("resource_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull()
  },
  (table) => [
    primaryKey({ columns: [table.actorUserId, table.scope, table.key] }),
    index("idempotency_record_expires_idx").on(table.expiresAt),
    index("idempotency_record_actor_scope_created_idx").on(table.actorUserId, table.scope, table.createdAt.desc()),
    check("idempotency_record_response_status_check", sql`${table.responseStatus} between 100 and 599`),
    check("idempotency_record_expires_after_created_check", sql`${table.expiresAt} > ${table.createdAt}`)
  ]
);

export const auditEvent = pgTable(
  "audit_event",
  {
    eventId: uuid("event_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    actorType: text("actor_type").notNull(),
    actorId: uuid("actor_id"),
    workspaceId: uuid("workspace_id"),
    action: varchar("action", { length: 128 }).notNull(),
    resourceType: varchar("resource_type", { length: 128 }).notNull(),
    resourceId: uuid("resource_id"),
    beforeSummary: jsonb("before_summary").notNull().default(sql`'{}'::jsonb`),
    afterSummary: jsonb("after_summary").notNull().default(sql`'{}'::jsonb`),
    summaryTruncated: boolean("summary_truncated").notNull().default(false),
    traceId: uuid("trace_id"),
    requestId: uuid("request_id"),
    aiRunId: uuid("ai_run_id"),
    result: text("result").notNull(),
    failureCode: varchar("failure_code", { length: 64 })
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.occurredAt] }),
    index("audit_event_workspace_occurred_idx").on(table.workspaceId, table.occurredAt.desc()),
    index("audit_event_actor_occurred_idx").on(table.actorId, table.occurredAt.desc()),
    index("audit_event_trace_idx").on(table.traceId),
    index("audit_event_resource_occurred_idx").on(table.resourceType, table.resourceId, table.occurredAt.desc()),
    check("audit_event_actor_type_check", sql`${table.actorType} in ('USER', 'ADMIN', 'WORKER', 'SYSTEM')`),
    check("audit_event_result_check", sql`${table.result} in ('SUCCESS', 'DENIED', 'FAILED')`)
  ]
);

export const metricDailyAggregate = pgTable(
  "metric_daily_aggregate",
  {
    metricDate: date("metric_date").notNull(),
    metricName: varchar("metric_name", { length: 64 }).notNull(),
    dimensionHash: varchar("dimension_hash", { length: 64 }).notNull().default("none"),
    value: numeric("value", { precision: 18, scale: 4 }).notNull().default("0"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    primaryKey({ columns: [table.metricDate, table.metricName, table.dimensionHash] }),
    index("metric_daily_aggregate_name_date_idx").on(table.metricName, table.metricDate.desc())
  ]
);

export const profile = pgTable(
  "profile",
  {
    workspaceId: uuid("workspace_id").primaryKey().references(() => workspace.id, { onDelete: "cascade" }),
    skills: jsonb("skills").notNull().default(sql`'[]'::jsonb`),
    entrepreneurStage: varchar("entrepreneur_stage", { length: 32 }).notNull(),
    businessGoal: varchar("business_goal", { length: 1000 }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    visibilitySetting: text("visibility_setting").notNull().default("PRIVATE"),
    ...timestamps,
    version: integer("version").notNull().default(1)
  },
  (table) => [
    check("profile_visibility_setting_check", sql`${table.visibilitySetting} = 'PRIVATE'`),
    check("profile_skills_is_array", sql`jsonb_typeof(${table.skills}) = 'array'`),
    check("profile_skills_maximum", sql`jsonb_array_length(${table.skills}) <= 20`)
  ]
);

export const platformOperator = pgTable(
  "platform_operator",
  {
    id: uuid("id").primaryKey(),
    subjectId: varchar("subject_id", { length: 128 }).notNull().unique(),
    status: text("status").notNull().default("ACTIVE"),
    mfaEnrolledAt: timestamp("mfa_enrolled_at", { withTimezone: true }).notNull(),
    ...timestamps,
    version: integer("version").notNull().default(1)
  },
  (table) => [
    check("platform_operator_status_check", sql`${table.status} in ('ACTIVE', 'SUSPENDED', 'REVOKED')`)
  ]
);

export const platformOperatorRole = pgTable(
  "platform_operator_role",
  {
    operatorId: uuid("operator_id").notNull().references(() => platformOperator.id),
    role: text("role").notNull(),
    grantedBy: uuid("granted_by").notNull().references(() => platformOperator.id),
    grantedAt: timestamp("granted_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    version: integer("version").notNull().default(1)
  },
  (table) => [
    primaryKey({ columns: [table.operatorId, table.role] }),
    check(
      "platform_operator_role_check",
      sql`${table.role} in ('OPERATIONS_READER', 'PLATFORM_ADMIN', 'SECURITY_AUDITOR', 'SUPPORT')`
    )
  ]
);

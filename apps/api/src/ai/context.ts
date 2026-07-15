import type { Pool, PoolClient } from "pg";
import type { AiMessage } from "./provider.js";
import { ApiError } from "../platform/errors.js";

type Capability = "TASK_BREAKDOWN" | "DAILY_TOP3";
type Context = { userId: string };

type ProjectRow = { id: string; name: string; objective: string; deliverable: string | null; status: string };
type TaskRow = { title: string; status: string; due_at: Date | null; estimated_minutes: number | null };
type CustomerRow = { name: string; stage: string; intent_level: string; next_action: string | null };
type ProfileRow = { skills: unknown; entrepreneur_stage: string; business_goal: string };

export interface AiContextInput {
  capability: Capability;
  projectId?: string;
  instruction?: string;
}

export interface AiContextSnapshot {
  messages: readonly AiMessage[];
  dataCategories: readonly { category: "profile" | "project" | "task" | "customer"; count: number }[];
  consentEvidence: readonly { type: "AI_BUSINESS_DATA"; status: "GRANTED"; policyVersion: string; purposeVersion: string }[];
  inputRedactionMethod: Record<string, string>;
}

function truncate(value: string | null, maximum: number): string | null {
  if (value === null) return null;
  const shortened = value.length <= maximum ? value : value.slice(0, maximum);
  return shortened
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED]")
    .replace(/\+?\d[\d\s-]{6,}\d/g, "[REDACTED]");
}

function instruction(value: string | undefined): string {
  if (value === undefined) return "";
  if (value.length > 2_000) throw new ApiError(422, "VALIDATION_FAILED", "补充说明不得超过 2000 个字符。");
  return truncate(value, 2_000) ?? "";
}

async function authorizedWorkspace(pool: Pool | PoolClient, userId: string): Promise<{ id: string; policyVersion: string; purposeVersion: string }> {
  const workspace = await pool.query<{ id: string }>("SELECT id FROM workspace WHERE owner_user_id=$1", [userId]);
  const workspaceId = workspace.rows[0]?.id;
  if (!workspaceId) throw new ApiError(404, "RESOURCE_NOT_FOUND", "当前账户尚未创建工作空间。");
  const consent = await pool.query<{ policy_version: string; purpose_version: string }>("SELECT policy_version,purpose_version FROM consent WHERE workspace_id=$1 AND consent_type='AI_BUSINESS_DATA' AND status='GRANTED'", [workspaceId]);
  const evidence = consent.rows[0];
  if (!evidence) throw new ApiError(403, "CONSENT_REQUIRED", "使用 AI 功能需要授权业务数据处理。");
  return { id: workspaceId, policyVersion: evidence.policy_version, purposeVersion: evidence.purpose_version };
}

function systemInstruction(capability: Capability): string {
  return capability === "TASK_BREAKDOWN"
    ? "You are an AI COO. Produce a task-planning draft only. Do not claim to have tools, do not invent facts, and do not create or modify business records."
    : "You are an AI COO. Produce a daily-priority draft only. Do not claim to have tools, do not invent facts, and do not create or modify business records.";
}

export async function buildAiContext(input: AiContextInput, context: Context, pool: Pool | PoolClient): Promise<AiContextSnapshot> {
  if (input.capability !== "TASK_BREAKDOWN" && input.capability !== "DAILY_TOP3") throw new ApiError(422, "VALIDATION_FAILED", "AI 能力无效。");
  if (input.capability === "TASK_BREAKDOWN" && !input.projectId) throw new ApiError(422, "VALIDATION_FAILED", "任务拆解必须指定项目。");
  if (input.capability === "DAILY_TOP3" && input.projectId !== undefined) throw new ApiError(422, "VALIDATION_FAILED", "每日三件事不接受项目参数。");
  const userInstruction = instruction(input.instruction);
  const workspace = await authorizedWorkspace(pool, context.userId);
  const profile = await pool.query<ProfileRow>("SELECT skills,entrepreneur_stage,business_goal FROM profile WHERE workspace_id=$1", [workspace.id]);
  const profileRow = profile.rows[0];
  if (!profileRow) throw new ApiError(422, "PROFILE_INCOMPLETE", "请先完成工作空间画像。");

  const projects = await pool.query<ProjectRow>(input.capability === "TASK_BREAKDOWN"
    ? "SELECT id,name,objective,deliverable,status FROM project WHERE id=$1 AND workspace_id=$2"
    : "SELECT id,name,objective,deliverable,status FROM project WHERE workspace_id=$1 AND status IN ('DRAFT','IN_PROGRESS','PAUSED') ORDER BY updated_at DESC,id DESC", input.capability === "TASK_BREAKDOWN" ? [input.projectId, workspace.id] : [workspace.id]);
  if (input.capability === "TASK_BREAKDOWN" && !projects.rows[0]) throw new ApiError(404, "RESOURCE_NOT_FOUND", "当前工作空间中不存在该项目。");

  const projectIds = projects.rows.map((project) => project.id);
  const tasks = projectIds.length === 0 ? [] : (await pool.query<TaskRow>("SELECT title,status,due_at,estimated_minutes FROM task WHERE workspace_id=$1 AND project_id=ANY($2::uuid[]) ORDER BY due_at ASC NULLS LAST,created_at ASC", [workspace.id, projectIds])).rows;
  const customers = input.capability === "DAILY_TOP3"
    ? (await pool.query<CustomerRow>("SELECT name,stage,intent_level,next_action FROM customer WHERE workspace_id=$1 ORDER BY updated_at DESC,id DESC", [workspace.id])).rows
    : [];
  const customerContext = customers.map((customer, index) => ({
    label: `客户-${String.fromCharCode(65 + index)}`,
    stage: customer.stage,
    intentLevel: customer.intent_level,
    nextAction: truncate(customer.next_action, 1_000)
  }));
  const safeContext = {
    profile: {
      skills: Array.isArray(profileRow.skills) ? profileRow.skills.filter((skill): skill is string => typeof skill === "string").map((skill) => truncate(skill, 200)) : [],
      entrepreneurStage: truncate(profileRow.entrepreneur_stage, 32),
      businessGoal: truncate(profileRow.business_goal, 1_000)
    },
    projects: projects.rows.map((project) => ({ name: truncate(project.name, 160), objective: truncate(project.objective, 2_000), deliverable: truncate(project.deliverable, 2_000), status: project.status })),
    tasks: tasks.map((task) => ({ title: truncate(task.title, 200), status: task.status, dueAt: task.due_at?.toISOString() ?? null, estimatedMinutes: task.estimated_minutes })),
    customers: customerContext
  };
  const dataCategories: AiContextSnapshot["dataCategories"] = [
    { category: "profile", count: 1 },
    { category: "project", count: projects.rows.length },
    { category: "task", count: tasks.length },
    ...(input.capability === "DAILY_TOP3" ? [{ category: "customer" as const, count: customers.length }] : [])
  ];
  return {
    messages: [
      { role: "system", content: systemInstruction(input.capability) },
      { role: "system", content: JSON.stringify({ type: "business_context", data: safeContext }) },
      { role: "user", content: userInstruction }
    ],
    dataCategories,
    consentEvidence: [{ type: "AI_BUSINESS_DATA", status: "GRANTED", policyVersion: workspace.policyVersion, purposeVersion: workspace.purposeVersion }],
    inputRedactionMethod: {
      profile: "truncate:skills=200,businessGoal=1000",
      project: "truncate:name=160,objective=2000,deliverable=2000",
      task: "truncate:title=200",
      customer: input.capability === "DAILY_TOP3" ? "tokenize:name,truncate:nextAction=1000,delete:notes" : "delete"
    }
  };
}

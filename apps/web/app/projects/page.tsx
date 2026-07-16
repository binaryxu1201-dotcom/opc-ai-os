"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ProtectedShell } from "../components/auth-ui";
import { ErrorState, ProjectForm, StatusBadge } from "../components/business-ui";
import { api, type Project } from "../lib/api";

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]); const [showForm, setShowForm] = useState(false); const [error, setError] = useState<unknown>(null);
  const load = () => { setError(null); void api.projects.list().then((result) => setProjects(result.projects)).catch(setError); }; useEffect(load, []);
  function filter(value: string) { void api.projects.list(value || undefined).then((result) => setProjects(result.projects)).catch(setError); }
  return <ProtectedShell><div className="page-header"><div><div className="eyebrow">项目</div><h1>你的经营项目</h1><p>从一个明确目标开始，逐步推进任务。</p></div><button className="button button-primary" onClick={() => setShowForm(true)}>新建项目</button></div>{showForm ? <section className="panel"><h2>新建项目</h2><ProjectForm onDone={(project) => { setProjects((current) => [project, ...current]); setShowForm(false); }} onCancel={() => setShowForm(false)} /></section> : null}{error ? <ErrorState error={error} retry={load} /> : null}{!error && projects.length === 0 && !showForm ? <section className="panel"><h2>还没有项目</h2><p>从一个正在推进的目标开始。</p><button className="button button-primary" onClick={() => setShowForm(true)}>创建第一个项目</button></section> : null}{!error && (projects.length > 0 || showForm) ? <section className="panel"><div className="list-filter"><label htmlFor="project-status">状态筛选</label><select id="project-status" onChange={(event) => filter(event.target.value)}><option value="">全部</option><option value="DRAFT">草稿</option><option value="IN_PROGRESS">进行中</option><option value="PAUSED">已暂停</option><option value="COMPLETED">已完成</option><option value="CANCELLED">已取消</option></select></div>{projects.map((project) => <div className="task-row" key={project.id}><div><Link className="text-link" href={`/projects/${project.id}`}>{project.name}</Link><div className="status"><StatusBadge value={project.status} /> · {project.taskSummary.completed}/{project.taskSummary.total} 项完成 · 更新于 {new Date(project.updatedAt).toLocaleDateString("zh-CN")}</div></div></div>)}</section> : null}</ProtectedShell>;
}

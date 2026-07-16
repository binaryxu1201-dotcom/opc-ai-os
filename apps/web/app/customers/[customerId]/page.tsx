"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ProtectedShell } from "../../components/auth-ui";
import { CustomerForm, ErrorState } from "../../components/business-ui";
import { api, type Customer, type StageHistory } from "../../lib/api";

const stageLabels: Record<string, string> = { LEAD: "线索", CONTACTED: "已联系", QUALIFIED: "已验证", WON: "已赢得", LOST: "已失去" };
const transitions: Record<string, string[]> = { LEAD: ["CONTACTED", "LOST"], CONTACTED: ["QUALIFIED", "LOST", "LEAD"], QUALIFIED: ["WON", "LOST", "CONTACTED"], WON: [], LOST: ["LEAD", "CONTACTED"] };

export default function CustomerDetailPage() {
  const params = useParams<{ customerId: string }>(); const id = params.customerId;
  const [customer, setCustomer] = useState<Customer | null>(null); const [history, setHistory] = useState<StageHistory[]>([]); const [editing, setEditing] = useState(false); const [target, setTarget] = useState(""); const [reason, setReason] = useState(""); const [error, setError] = useState<unknown>(null);
  const load = async () => { try { const [next, nextHistory] = await Promise.all([api.customers.get(id), api.customers.history(id)]); setCustomer(next); setHistory(nextHistory.history); } catch (nextError) { setError(nextError); } };
  useEffect(() => { void load(); }, [id]);
  async function changeStage() { if (!customer || !target) return; try { const next = await api.customers.changeStage(id, { toStage: target, ...(reason ? { reason } : {}), expectedVersion: customer.version }); setCustomer(next); setReason(""); setTarget(""); await load(); } catch (nextError) { setError(nextError); } }
  const availableTransitions = customer ? (transitions[customer.stage] ?? []) : [];
  return <ProtectedShell><div className="page-header"><div><Link className="text-link" href="/customers">返回客户</Link><h1>{customer?.name ?? "客户详情"}</h1><p>{customer ? `${stageLabels[customer.stage] ?? customer.stage} · 意向度 ${customer.intentLevel}` : "正在加载客户…"}</p></div></div>{error ? <ErrorState error={error} retry={() => void load()} /> : null}{customer ? <><section className="panel"><div className="page-header"><div><h2>客户信息</h2><p>来源：{customer.source}</p><p>下一步：{customer.nextAction || "未填写"}</p><p>备注：{customer.notes || "未填写"}</p></div><button className="button button-secondary" onClick={() => setEditing((value) => !value)}>编辑</button></div>{editing ? <CustomerForm initial={customer} onDone={(next) => { setCustomer(next); setEditing(false); }} onCancel={() => setEditing(false)} /> : null}</section><section className="panel"><h2>改变阶段</h2>{availableTransitions.length === 0 ? <p className="status">当前阶段没有可用的下一步。</p> : <div className="form-stack"><div className="field"><label htmlFor="customer-stage">目标阶段</label><select id="customer-stage" value={target} onChange={(event) => setTarget(event.target.value)}><option value="">请选择</option>{availableTransitions.map((stage) => <option key={stage} value={stage}>{stageLabels[stage]}</option>)}</select></div><div className="field"><label htmlFor="stage-reason">原因（回退或重新激活时必填）</label><textarea id="stage-reason" maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></div><button className="button button-primary" disabled={!target} onClick={() => void changeStage()}>保存阶段</button></div>}</section><section className="panel"><h2>阶段历史</h2>{history.length === 0 ? <p className="status">暂无阶段变更记录。</p> : history.map((item) => <div className="task-row" key={item.id}><div><strong>{item.fromStage ? stageLabels[item.fromStage] : "新建"} → {stageLabels[item.toStage]}</strong><div className="status">{new Date(item.changedAt).toLocaleString("zh-CN")}{item.reason ? ` · ${item.reason}` : ""}</div></div></div>)}</section></> : null}</ProtectedShell>;
}

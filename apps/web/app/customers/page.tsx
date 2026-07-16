"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ProtectedShell } from "../components/auth-ui";
import { CustomerForm, ErrorState, StatusBadge } from "../components/business-ui";
import { api, type Customer } from "../lib/api";

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]); const [showForm, setShowForm] = useState(false); const [error, setError] = useState<unknown>(null);
  const load = () => { setError(null); void api.customers.list().then((result) => setCustomers(result.customers)).catch(setError); }; useEffect(load, []);
  return <ProtectedShell><div className="page-header"><div><div className="eyebrow">客户</div><h1>CRM-lite</h1><p>记录关系进展，下一步始终清晰。</p></div><button className="button button-primary" onClick={() => setShowForm(true)}>录入客户</button></div>{showForm ? <section className="panel"><h2>新建客户</h2><CustomerForm onDone={(customer) => { setCustomers((current) => [customer, ...current]); setShowForm(false); }} onCancel={() => setShowForm(false)} /></section> : null}{error ? <ErrorState error={error} retry={load} /> : null}{!error && customers.length === 0 && !showForm ? <section className="panel"><h2>还没有客户</h2><p>先记录一个需要跟进的关系。</p><button className="button button-primary" onClick={() => setShowForm(true)}>录入第一个客户</button></section> : null}{!error && (customers.length > 0 || showForm) ? <section className="panel">{customers.map((customer) => <div className="task-row" key={customer.id}><div><Link className="text-link" href={`/customers/${customer.id}`}>{customer.name}</Link><div className="status"><StatusBadge value={customer.stage} /> · 意向度 {customer.intentLevel}</div></div></div>)}</section> : null}</ProtectedShell>;
}

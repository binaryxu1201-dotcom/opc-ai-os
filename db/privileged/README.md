# 特权数据库维护脚本

这些脚本不属于普通应用迁移，禁止由应用、Worker 或本地开发账号自动执行。

## 审计分区维护函数

在普通迁移 `0007_system_audit_partition_jobs` 已部署后，使用受控 `audit_owner` 部署角色执行：

```sql
\i db/privileged/0007_audit_partition_maintenance.sql
```

脚本创建 `SECURITY DEFINER public.maintain_audit_partitions()`：该函数预建当前月及未来 12 个月的 `audit_event` 分区，并仅授权应用/Worker 角色执行函数，**不授予任何 schema 或分区 DDL 权限**。

Worker 会以 UTC 月创建系统级 `AUDIT_PARTITION_MAINTAIN` 任务；函数尚未部署时，任务将安全地重试并在三次失败后进入死信，错误摘要不包含数据库内部细节。

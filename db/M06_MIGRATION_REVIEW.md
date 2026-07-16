# M6 / G2 迁移审查记录

- 文档版本：v1.0
- 日期：2026-07-16
- 迁移工具：Drizzle Kit（`db/src/migrate.ts` → `migrate(drizzle(pool), { migrationsFolder: "migrations" })`）
- 审查人：Sisyphus（自动化审查）

## 迁移清单（db/migrations/meta/_journal.json）

| idx | tag | 说明 |
|----|------|------|
| 0 | 0000_shallow_bulldozer | M01 账户/会话/工作空间/画像/运营角色 |
| 1 | 0001_special_rage | M02 项目/任务/客户/客户阶段历史（三级深度、复合外键跨空间阻断） |
| 2 | 0002_lumpy_lenny_balinger | M03 授权/AI run/建议/决议/用量日聚合 |
| 3 | 0003_silly_typhoid_mary | M04 导出/下载令牌/注销/异步作业/幂等记录 |
| 4 | 0004_uneven_terror | M05 审计月分区 + metric_daily_aggregate（audit_owner 权限收紧） |
| 5 | 0005_ai_suggestion_decision_cascade | M06 建议决议外键改 ON DELETE cascade |
| 6 | 0006_allow_cascaded_ai_decision_deletion | M07 决议触发器加 WHEN pg_trigger_depth()=1 |
| 7 | 0007_system_audit_partition_jobs | M05 补充：审计分区维护 Worker 作业（特权脚本独立部署） |

## 可重复应用验证

- `_journal.json` 含 8 个顺序条目（idx 0–7），均带 `breakpoints: true`，Drizzle 按 hash 幂等跳过已应用迁移。
- 全部迁移已在开发库 `opc_ai_os_dev` 成功应用并重复执行通过（CHECKPOINT M5 记录确认 M01–M07 可重复）。
- `0005`/`0006` 刻意不使用 `CREATE OR REPLACE FUNCTION`，普通迁移账号（无 public schema CREATE 权限）也可 `pnpm db migrate` 成功。

## 锁表/回滚评估

- 均为新增表/约束/触发器/函数，无破坏性列删除或类型变更；可经后续 expand/contract 迁移回退。
- 特权脚本 `db/privileged/0007_audit_partition_maintenance.sql` 由受控 `audit_owner` 角色部署，普通应用迁移账号被拒绝，符合 §5.3 DB-03 / §8.3。
- 回滚策略：应用代码回退优先；破坏性 schema 不做即时删除。

## 结论

G2 数据迁移门禁：✅ 通过（迁移序列、约束、触发器、回滚路径均可审查；特权分区维护已独立部署）。
待补：预发环境独立演练回滚 + 10 万条审计写入性能（归入 M6 预发 G6 演练，需环境支持）。

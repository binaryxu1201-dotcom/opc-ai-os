# M05 审计角色 Bootstrap

`0004_uneven_terror.sql` 假定数据库已存在无登录的 `audit_owner` 角色，并且迁移角色可以临时切换到该角色。该角色创建与 `public` schema 的所有权转移必须由受控 DBA 连接执行，不能由常规应用迁移角色完成。

## 本地开发 Bootstrap

以 PostgreSQL 管理员连接至目标数据库执行：

```sql
CREATE ROLE audit_owner NOLOGIN NOINHERIT;
GRANT audit_owner TO opc_ai_os_dev WITH ADMIN OPTION;
GRANT USAGE, CREATE ON SCHEMA public TO audit_owner;
```

执行 `pnpm.cmd db:migrate` 后，迁移会：

1. 以 `audit_owner` 创建分区审计表和受控函数；
2. 撤销应用角色的 `audit_owner` 成员资格；
3. 撤销应用角色在 `public` schema 的 `CREATE` 权限。

随后仍须以 DBA 连接执行以下所有权收紧步骤（常规应用角色不是 schema 所有者时无需重复）：

```sql
ALTER SCHEMA public OWNER TO audit_owner;
REVOKE CREATE ON SCHEMA public FROM opc_ai_os_dev;
REVOKE audit_owner FROM opc_ai_os_dev;
```

生产环境应以部署身份替换 `opc_ai_os_dev`；不得将 `audit_owner` 赋予 API、Worker 或连接池运行身份。

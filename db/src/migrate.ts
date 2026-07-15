import { loadEnvironment } from "@opc/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const environment = loadEnvironment();
const pool = new Pool({ connectionString: environment.DATABASE_URL });
const database = drizzle(pool);

try {
  await migrate(database, { migrationsFolder: "migrations" });
} finally {
  await pool.end();
}

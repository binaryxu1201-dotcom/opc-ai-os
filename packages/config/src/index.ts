import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  WEB_ORIGIN: z.string().url(),
  ACCESS_TOKEN_SECRET: z.string().min(32),
  ACCESS_TOKEN_ISSUER: z.string().min(1).default("opc-ai-os"),
  ACCESS_TOKEN_AUDIENCE: z.string().min(1).default("opc-web")
});

export type Environment = z.infer<typeof environmentSchema>;

function loadProjectEnvironment(startDirectory: string): void {
  let directory = startDirectory;

  while (true) {
    const environmentFile = resolve(directory, ".env");
    if (existsSync(environmentFile)) {
      loadDotenv({ path: environmentFile });
      return;
    }

    const parentDirectory = dirname(directory);
    if (parentDirectory === directory) {
      return;
    }
    directory = parentDirectory;
  }
}

export function loadEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  if (source === process.env) {
    loadProjectEnvironment(process.cwd());
  }
  return environmentSchema.parse(source);
}

import { loadEnvironment } from "@opc/config";
import { buildApp } from "./app.js";

const environment = loadEnvironment();
const app = buildApp(environment);

async function start(): Promise<void> {
  await app.listen({ host: environment.API_HOST, port: environment.API_PORT });
}

void start().catch(async (error: unknown) => {
  app.log.error(error, "Unable to start API server");
  await app.close();
  process.exitCode = 1;
});

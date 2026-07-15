import { loadEnvironment } from "@opc/config";
import { Queue } from "bullmq";

const environment = loadEnvironment();
const redisUrl = new URL(environment.REDIS_URL);
const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || "6379"),
  maxRetriesPerRequest: null,
  ...(redisUrl.username ? { username: decodeURIComponent(redisUrl.username) } : {}),
  ...(redisUrl.password ? { password: decodeURIComponent(redisUrl.password) } : {})
};
const scaffoldQueue = new Queue("opc-scaffold", { connection });

async function start(): Promise<void> {
  await scaffoldQueue.waitUntilReady();
  console.info(JSON.stringify({ service: "worker", status: "ready" }));
}

async function stop(): Promise<void> {
  await scaffoldQueue.close();
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
void start().catch(async (error: unknown) => {
  console.error(JSON.stringify({ service: "worker", status: "failed", error: String(error) }));
  await stop();
  process.exitCode = 1;
});

import http from "k6/http";
import { check, sleep } from "k6";

/**
 * M6 / G6 性能压测骨架（k6）。
 * 口径见 docs/07 §7：查询 API P95 ≤500ms、普通写 P95 ≤300ms、错误率 <1%。
 * 运行： k6 run apps/web/load/api-smoke.js
 * 需先设置： API_BASE_URL、有效测试令牌 TEST_TOKEN、独立测试工作空间。
 */
const BASE = __ENV.API_BASE_URL ?? "http://localhost:3001";
const TOKEN = __ENV.TEST_TOKEN ?? "";

export const options = {
  scenarios: {
    read_write_mix: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: 20 },
        { duration: "1m", target: 50 },
        { duration: "30s", target: 0 }
      ]
    }
  },
  thresholds: {
    http_req_duration: ["p(95)<500"],
    http_req_failed: ["rate<0.01"]
  }
};

export default function () {
  const headers = { Authorization: `Bearer ${TOKEN}`, Origin: "http://localhost:3000", "X-OPC-CSRF": "1" };
  const list = http.get(`${BASE}/api/v1/projects`, { headers });
  check(list, { "projects 200": (r) => r.status === 200 });
  sleep(1);
  const create = http.post(
    `${BASE}/api/v1/projects`,
    JSON.stringify({ name: `k6-${__VU}-${__ITER}`, objective: "load test" }),
    { headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": `k6-${__VU}-${__ITER}` } }
  );
  check(create, { "create 201/409": (r) => r.status === 201 || r.status === 409 });
  sleep(1);
}

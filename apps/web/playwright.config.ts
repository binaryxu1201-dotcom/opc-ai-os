import { defineConfig, devices } from "@playwright/test";

/**
 * M6 / G3 + G8 脚手架：Playwright E2E 与移动/桌面无障碍基线。
 * 运行前需安装浏览器： pnpm --filter @opc/web exec playwright install --with-deps
 * 本地起服务： pnpm dev （web=3000, api=3001）
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [["html", { outputFolder: "playwright-report" }], ["list"]],
  use: {
    baseURL: process.env.WEB_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure"
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 5"] } }
  ]
});

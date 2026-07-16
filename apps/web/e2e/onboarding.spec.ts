import { expect, test } from "@playwright/test";

/**
 * E2E-01 注册 → 工作空间 → 画像 → 工作台（桌面 + 移动）。
 * 基线骨架：覆盖注册、工作空间创建、画像完成与跳转到工作台。
 * 实际运行需后端可连（NEXT_PUBLIC_API_BASE_URL 指向本地 api:3001）。
 */
test.describe("E2E-01 注册到工作台", () => {
  const email = `e2e-${Date.now()}@example.test`;
  const password = "correct-horse-battery-staple";

  test("注册并进入引导", async ({ page }) => {
    await page.goto("/auth/register");
    await page.getByLabel("邮箱（可选）").fill(email);
    await page.getByLabel("密码").fill(password);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "创建账户" }).click();
    await expect(page.getByText("账户已创建")).toBeVisible();
  });

  test("创建工作空间并完成画像", async ({ page }) => {
    await page.goto("/onboarding/workspace");
    await page.getByLabel("名称").fill("E2E 工作空间");
    await page.getByRole("button", { name: /创建工作空间/ }).click();
    await expect(page).toHaveURL(/\/onboarding\/profile/);
    await page.getByLabel(/业务目标/).fill("验证 V1-A 发布门禁");
    await page.getByRole("button", { name: /保存画像/ }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  });
});

/**
 * E2E-12 会话轮换与失效：Access 失效后回到登录页。
 * 骨架：清除本机 token 后应被重定向到登录。
 */
test("E2E-12 未登录访问受保护页跳转登录", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/auth\/login/);
});

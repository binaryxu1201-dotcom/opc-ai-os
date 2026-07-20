import { expect, type Page, test } from "@playwright/test";

/**
 * E2E-01 注册 → 工作空间 → 画像 → 工作台（桌面 + 移动）。
 * 基线骨架：覆盖注册、工作空间创建、画像完成与跳转到工作台。
 * 实际运行需后端可连（NEXT_PUBLIC_API_BASE_URL 指向本地 api:3001）。
 */
test.describe("E2E-01 注册到工作台", () => {
  const password = "correct-horse-battery-staple";

  async function register(page: Page): Promise<string> {
    const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
    await page.goto("/auth/register");
    await page.getByLabel("邮箱（可选）").fill(email);
    await page.getByLabel("密码").fill(password);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "创建账户" }).click();
    await expect(page.getByText("账户已创建")).toBeVisible();
    return email;
  }

  async function login(page: Page, email: string): Promise<void> {
    await page.getByRole("link", { name: "前往登录" }).click();
    await page.getByLabel("邮箱或手机号").fill(email);
    await page.getByLabel("密码").fill(password);
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page.getByLabel("工作空间名称")).toBeVisible();
  }

  test("注册并进入引导", async ({ page }) => {
    await register(page);
  });

  test("创建工作空间并完成画像", async ({ page }) => {
    const email = await register(page);
    await login(page, email);
    await page.getByLabel("工作空间名称").fill("E2E 工作空间");
    await page.getByRole("button", { name: /继续设置画像/ }).click();
    await expect(page).toHaveURL(/\/onboarding\/profile/);
    await page.getByLabel("创业阶段").fill("验证阶段");
    await page.getByLabel(/当前经营目标/).fill("验证 V1-A 发布门禁");
    await page.getByRole("button", { name: /继续设置授权/ }).click();
    await expect(page).toHaveURL(/\/onboarding\/consents/);
    await page.getByRole("link", { name: "进入工作台" }).click();
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

import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * G8 无障碍基线：对核心页面运行 axe-core，仅允许 wcag2a/wcag2aa 规则。
 * 运行前需安装依赖： @axe-core/playwright（见 apps/web/package.json devDependencies）
 */
test.describe("G8 无障碍 axe 基线", () => {
  test("dashboard 无 wcag2a/aa 违规", async ({ page }) => {
    await page.goto("/dashboard");
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(results.violations).toEqual([]);
  });

  test("auth/login 无 wcag2a/aa 违规", async ({ page }) => {
    await page.goto("/auth/login");
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(results.violations).toEqual([]);
  });
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const adminHtml = await readFile(new URL("../admin/index.html", import.meta.url), "utf8");

test("后台用侧边栏拆分主要工作页面", () => {
  for (const [key, label] of [
    ["overview", "概览"],
    ["accounts", "账号管理"],
    ["tasks", "任务记录"],
    ["productivity", "产值统计"],
    ["chat", "对话测试"],
    ["edit", "图生图测试"],
    ["api", "API 接入"],
    ["settings", "系统设置"]
  ]) {
    assert.match(adminHtml, new RegExp(`key: "${key}", label: "${label}"`));
  }
  assert.match(adminHtml, /className: "admin-sidebar"/);
  assert.match(adminHtml, /className: "sidebar-menu"/);
  assert.match(adminHtml, /selectedKeys: \[activePage\]/);
});

test("侧边栏切换时只显示当前页面并保留刷新位置", () => {
  assert.match(adminHtml, /useState\(dashboardPageFromHash\)/);
  assert.match(adminHtml, /window\.location\.hash = pageKey/);
  assert.match(adminHtml, /window\.addEventListener\("hashchange", syncPageFromHash\)/);
  assert.match(adminHtml, /hidden: activePage !== "overview"/);
  assert.match(adminHtml, /hidden: activePage !== "accounts"/);
  assert.match(adminHtml, /hidden: !operationPageKeys\.has\(activePage\)/);
  assert.match(adminHtml, /activeKey: operationPageKeys\.has\(activePage\) \? activePage : "tasks"/);
  assert.match(adminHtml, /renderTabBar: \(\) => null/);
});

test("窄屏使用可关闭的功能菜单", () => {
  assert.match(adminHtml, /const \[mobileNavOpen, setMobileNavOpen\] = useState\(false\)/);
  assert.match(adminHtml, /className: "mobile-menu-button"/);
  assert.match(adminHtml, /placement: "left"/);
  assert.match(adminHtml, /open: mobileNavOpen/);
  assert.match(adminHtml, /onClose: \(\) => setMobileNavOpen\(false\)/);
  assert.match(adminHtml, /@media \(max-width: 980px\)[\s\S]*?\.admin-sidebar \{[\s\S]*?display: none/);
});

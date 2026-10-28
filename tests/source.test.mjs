import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// Obsidian 的 createEl 只给 <input> 设 type；写在 <button> 的顶层选项里会被忽略，
// 按钮就成了默认的提交按钮，放在表单里一点就提交（编辑弹窗点日期就保存并关闭，就是这么来的）。
test("按钮的 type 必须写在 attr 里", () => {
  const dir = new URL("../src/view/", import.meta.url);
  const bad = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ts")) continue;
    const lines = readFileSync(new URL(name, dir), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/createEl\("button",\s*\{(?:(?!attr:)[^}])*\btype:/.test(line)) bad.push(`${name}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, []);
});

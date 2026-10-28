import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * 设计规范的防回退检查（Devbook/滴答面板设计规范-20261028.md 第五节第四步）：
 * 颜色、圆角、字号只能在变量块里定义，组件里一律引用 --dida-* 变量。
 * 报错时列出行号和原文，照着换成对应变量即可。
 */
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const start = css.indexOf("/* @tokens-start */");
const end = css.indexOf("/* @tokens-end */");

// 注释换成等长空白，行号不变
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
const blank = (s) => s.replace(/[^\n]/g, " ");
const body = stripComments(css.slice(0, start) + blank(css.slice(start, end)) + css.slice(end));

function offenders(pattern, allow = () => false) {
  const out = [];
  body.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(pattern)) if (!allow(m, line)) out.push(`${i + 1}: ${line.trim()}`);
  });
  return out;
}

test("变量块存在且只有一处", () => {
  assert.ok(start >= 0 && end > start, "缺少 /* @tokens-start */ … /* @tokens-end */ 变量块");
  assert.equal(css.split("/* @tokens-start */").length, 2, "变量块只能有一处");
});

test("变量块以外不写死颜色", () => {
  const hex = offenders(/#[0-9a-fA-F]{3,8}\b/g);
  const rgb = offenders(/\b(?:rgba?|hsla?)\(/g, (m, line) => /rgba?\(var\(--/.test(line.slice(m.index)));
  assert.deepEqual([...hex, ...rgb], []);
});

test("圆角只用规范的 5 档", () => {
  const bad = offenders(/border(?:-[a-z]+)*-radius:\s*([^;]+);/g, (m) =>
    m[1].split(/\s+/).every((v) => v === "0" || /^var\(--dida-r-(xs|sm|md|lg|full)\)$/.test(v))
  );
  assert.deepEqual(bad, []);
});

test("字号只用规范的 6 档", () => {
  const bad = offenders(/font-size:\s*([^;]+);/g, (m) => /^var\(--dida-fs-(xs|sm|md|lg|xl|2xl)\)$|^inherit$|^[\d.]+em$/.test(m[1].trim()));
  assert.deepEqual(bad, []);
});

test("组件里不直接引用 Obsidian 的文字色和字号变量", () => {
  const bad = offenders(/var\(--(text-normal|text-muted|text-faint|text-error|font-ui-[a-z]+|background-modifier-hover|background-modifier-form-field|mono-rgb-100|color-[a-z]+)\)/g);
  assert.deepEqual(bad, []);
});

test("按钮先清掉 Obsidian 默认样式，按钮组件一律写成 button.类名", () => {
  assert.ok(/:is\(\.dida-panel, \.dida-dock, \.dida-pop, \.dida-block\) button \{/.test(body), "缺少按钮基础重置");
  // 这些类只用在 <button> 上；只写类名的规则权重低于 Obsidian 的 button:not(.clickable-icon)，会被白底盖掉
  const buttons = ["dida-ibtn", "dida-tab", "dida-ftag", "dida-qchip", "dida-ov-stat", "dida-note-btn", "dida-lane-action", "dida-group-action", "dida-board-jump-pill", "dida-new-column-btn", "dida-send-btn", "dida-toolbar-btn", "dida-chat-nav-btn"];
  const bad = [];
  body.split("\n").forEach((line, i) => {
    if (!line.includes("{") && !line.trim().endsWith(",")) return;
    for (const c of buttons) {
      if (new RegExp(`(^|[\\s,>+~(])\\.${c}(?![\\w-])`).test(line)) bad.push(`${i + 1}: ${line.trim()}`);
    }
  });
  assert.deepEqual(bad, []);
});

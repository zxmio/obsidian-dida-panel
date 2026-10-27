import { test } from "node:test";
import assert from "node:assert/strict";
import { appendNoteLink, firstLinkedPath, noteContentLine, obsidianOpenUrl } from "../src/dida/deeplink.ts";

const vault = "Todaylab";
const path = "03内容输出/公众号/用 Claude Code 做滴答清单插件.md";

test("深链整体 URL 编码，斜杠也编码", () => {
  const url = obsidianOpenUrl(vault, path);
  assert.ok(url.startsWith("obsidian://open?vault=Todaylab&file="));
  assert.ok(url.includes("%2F"));
  assert.ok(!url.includes("/", "obsidian://".length));
  assert.ok(url.includes("%20"));
});

test("正文行按工作区约定：显示完整相对路径", () => {
  const line = noteContentLine(vault, path);
  assert.ok(line.startsWith(`正文：[${path}](obsidian://open?vault=Todaylab&file=`));
});

test("能从正文里解出第一个链接的路径", () => {
  const content = `${noteContentLine(vault, path)}\n来源：[a.md](obsidian://open?vault=Todaylab&file=a.md)`;
  assert.equal(firstLinkedPath(content), path);
  assert.equal(firstLinkedPath("没有链接"), null);
});

test("追加链接的四种情况", () => {
  assert.equal(appendNoteLink("", vault, path), noteContentLine(vault, path));
  const existing = noteContentLine(vault, path);
  assert.equal(appendNoteLink(existing, vault, path), existing);
  assert.equal(appendNoteLink("正文：待建\n来源：口述", vault, path), `${noteContentLine(vault, path)}\n来源：口述`);
  const appended = appendNoteLink("随手记的备注", vault, path);
  assert.ok(appended.startsWith("随手记的备注\n关联：[用 Claude Code 做滴答清单插件.md]("));
});

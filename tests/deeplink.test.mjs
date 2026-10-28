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

test("正文里的任务列表按序号翻勾选", async () => {
  const { toggleTaskLine } = await import("../src/dida/taskList.ts");
  const src = "上过课的\n- [ ] 林一鹤\n  - [x] 子项\n1. [ ] 编号的";
  assert.equal(toggleTaskLine(src, 0), "上过课的\n- [x] 林一鹤\n  - [x] 子项\n1. [ ] 编号的");
  assert.equal(toggleTaskLine(src, 1), "上过课的\n- [ ] 林一鹤\n  - [ ] 子项\n1. [ ] 编号的");
  assert.equal(toggleTaskLine(src, 2), "上过课的\n- [ ] 林一鹤\n  - [x] 子项\n1. [x] 编号的");
  assert.equal(toggleTaskLine(src, 3), null);
});

test("正文 / 来源 / 关联三种链接各写各的", async () => {
  const { setBodyNote, setSourceNote, appendRelatedNote, boundNotePath, sourceNotePath } = await import("../src/dida/deeplink.ts");
  let c = "状态：没回\n来源：[复盘.md](obsidian://open?vault=V&file=a%2F%E5%A4%8D%E7%9B%98.md)";
  assert.equal(boundNotePath(c), "a/复盘.md");
  c = setBodyNote(c, "V", "a/客户.md");
  assert.equal(c.split("\n")[0], "正文：[a/客户.md](obsidian://open?vault=V&file=a%2F%E5%AE%A2%E6%88%B7.md)");
  assert.equal(boundNotePath(c), "a/客户.md");
  assert.equal(sourceNotePath(c), "a/复盘.md");
  // 再绑一篇是替换，不是再加一行
  c = setBodyNote(c, "V", "a/新.md");
  assert.equal(c.match(/^正文：/gm)?.length, 1);
  c = setSourceNote(c, "V", "b/纪要.md");
  assert.equal(c.match(/^来源：/gm)?.length, 1);
  assert.equal(sourceNotePath(c), "b/纪要.md");
  c = appendRelatedNote(c, "V", "c/参考.md");
  c = appendRelatedNote(c, "V", "c/参考.md");
  assert.equal(c.match(/^关联：/gm)?.length, 1);
  assert.equal(setBodyNote("正文：待建", "V", "x.md"), "正文：[x.md](obsidian://open?vault=V&file=x.md)");
});

test("列表项后面紧跟的普通行另起一段", async () => {
  const { separateListLines } = await import("../src/dida/taskList.ts");
  assert.equal(separateListLines("上过课的\n- [ ] 林一鹤\n想上课没上的\n- [ ] "), "上过课的\n- [ ] 林一鹤\n\n想上课没上的\n- [ ] ");
  // 缩进的续行、连续的列表项不动
  assert.equal(separateListLines("- a\n  续行\n- b"), "- a\n  续行\n- b");
});

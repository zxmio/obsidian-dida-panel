/** 任务正文里的 Markdown 任务列表。纯函数，不依赖 Obsidian，方便单测。 */

/** 第 index 个任务列表项（- [ ] / 1. [x]）的勾选状态翻过来；找不到返回 null */
export function toggleTaskLine(source: string, index: number): string | null {
  let n = -1;
  let hit = false;
  const out = source.replace(/^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/gm, (m, head: string, mark: string, tail: string) => {
    n++;
    if (n !== index) return m;
    hit = true;
    return `${head}${mark === " " ? "x" : " "}${tail}`;
  });
  return hit ? out : null;
}

/**
 * 滴答的编辑器一行就是一段：列表项下面紧跟一行普通文字，在滴答里是另起一行，
 * 按 Markdown 却会被并进上一个列表项（「懒续行」）。渲染前在这种地方补一个空行，显示和滴答一致。
 * 只用于显示，存回去的还是原文。
 */
export function separateListLines(source: string): string {
  const lines = source.split("\n");
  const isList = (l: string): boolean => /^\s*(?:[-*+]|\d+[.)])\s/.test(l) || /^\s*(?:[-*+]|\d+[.)])$/.test(l);
  const out: string[] = [];
  lines.forEach((line, i) => {
    const prev = i > 0 ? lines[i - 1] : "";
    if (i > 0 && isList(prev) && line.trim() && !isList(line) && !/^\s/.test(line)) out.push("");
    out.push(line);
  });
  return out.join("\n");
}

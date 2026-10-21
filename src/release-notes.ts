/** 把 GitHub Release body（CI 生成的 markdown）整理为可逐行展示的条目。
 *  结构固定为「## Changes\n\n- …\n---\nFull changelog: …」：
 *  保留列表项与普通文本行，去标题、空行与 --- 之后的尾注。 */
export function releaseNotesItems(notes: string): string[] {
  const out: string[] = [];
  for (const raw of notes.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === '---') break; // 之后是 Full changelog 尾注，不再展示
    if (line.startsWith('#')) continue;
    // 列表项去掉 - / * / • 前缀；其余行原样保留（如补充段落）
    const item = line.replace(/^[-*•]\s+/, '');
    out.push(item);
  }
  return out;
}

/** 字节数格式化（更新包大小 / 下载进度共用） */
export function fmtBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

// 提取 CHANGELOG.md 中指定版本的小节（「## v0.4.5」起、下一个「## v」前），输出到 stdout
// 供 Release 工作流生成发布说明：node scripts/extract-changelog.mjs v0.4.5
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tag = process.argv[2];

if (!tag) {
  console.error('用法：node scripts/extract-changelog.mjs <tag>，如 v0.4.5');
  process.exit(1);
}

const lines = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);
const start = lines.findIndex((line) => line.startsWith(`## ${tag}`));
if (start === -1) {
  console.error(`CHANGELOG.md 中未找到「## ${tag}」小节，请先补充该版本的更新记录`);
  process.exit(1);
}

const rest = lines.slice(start + 1);
const end = rest.findIndex((line) => line.startsWith('## v'));
const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();

// console.log 保证末尾带换行：$GITHUB_OUTPUT 的 heredoc 分隔符必须独占一行，
// 输出缺换行会把结束分隔符粘到正文最后一行，导致 runner 报「Matching delimiter not found」
console.log(body || '变更内容见 CHANGELOG.md');

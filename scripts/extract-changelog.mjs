// Extract one version's section from CHANGELOG.md (from the "## <tag>" heading
// up to the next "## v" heading) and print it to stdout.
// Used by the release workflow to build release notes:
//   node scripts/extract-changelog.mjs v0.4.5
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tag = process.argv[2];

if (!tag) {
  console.error('Usage: node scripts/extract-changelog.mjs <tag>, e.g. v0.4.5');
  process.exit(1);
}

const lines = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').split(/\r?\n/);
const start = lines.findIndex((line) => line.startsWith(`## ${tag}`));
if (start === -1) {
  console.error(`No "## ${tag}" section in CHANGELOG.md — add it before releasing`);
  process.exit(1);
}

const rest = lines.slice(start + 1);
const end = rest.findIndex((line) => line.startsWith('## v'));
const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();

// console.log guarantees a trailing newline: the heredoc delimiter written to
// $GITHUB_OUTPUT must sit on its own line, otherwise the runner fails with
// "Matching delimiter not found".
console.log(body || 'See CHANGELOG.md for details.');

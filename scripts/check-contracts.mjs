#!/usr/bin/env node
/**
 * 前后端契约对账：把「靠记忆同步」变成「靠机器门禁」。
 *
 * 检查三类契约（详见 AGENTS.md「三条契约」）：
 *   1. 事件：前端 listen 的 sn-* 事件，Rust 侧必须真的有同名发射
 *      （错误级——拼错/改名漏一侧，运行期表现为功能静默失效）
 *   2. 命令：前端 invoke 的命令名，必须出现在 lib.rs generate_handler! 列表
 *      （错误级——未注册的命令 invoke 会直接 reject）
 *   3. 反向：Rust 注册但前端从未 invoke 的命令、发射但前端从未 listen 的事件
 *      （警告级——可能是预留或遗漏，人工判断）
 *
 * 用法：node scripts/check-contracts.mjs   （CI 与 npm run contracts 同款）
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 递归收集目录下指定扩展名的文件 */
function walk(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'target' || name === 'dist') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

const read = (p) => readFileSync(p, 'utf8');

/* ---------- 1. Rust 侧：事件发射 + 命令注册 ---------- */

const rustFiles = walk(join(ROOT, 'src-tauri/src'), ['.rs']);
const rustText = rustFiles.map((p) => read(p)).join('\n');

// Rust 侧出现过的全部 sn-* 字符串字面量。作为「发射集合」的保守超集
// （文档注释也会引用事件名——只会漏报不会误报错误级判定，方向安全）
const rustEvents = new Set([...rustText.matchAll(/"(sn-[a-z0-9-]+)"/g)].map((m) => m[1]));

// generate_handler![...] 列表（lib.rs）。命令可带模块前缀（translate::xxx）
const libText = read(join(ROOT, 'src-tauri/src/lib.rs'));
const handlerMatch = libText.match(/generate_handler!\[([\s\S]*?)\]/);
if (!handlerMatch) {
  console.error('::error::未能在 lib.rs 中找到 generate_handler![...] 列表');
  process.exit(1);
}
// 按逗号切分再取每段的末段标识符（命令可带模块前缀 translate::xxx；
// 列表末项可能无尾逗号，逐项切分比逐逗号正则更稳）
const rustCommands = new Set(
  handlerMatch[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split('::').pop()),
);

/* ---------- 2. 前端侧：listen 事件 + invoke 命令 ---------- */

const feFiles = walk(join(ROOT, 'src'), ['.ts', '.tsx']).filter((p) => !p.includes('/dev/'));
const feText = feFiles.map((p) => read(p)).join('\n');

// listen 的事件名。容忍泛型与跨行：listen<{…}>(\n  'sn-xxx',
// 从 listen 起懒匹配 ≤200 字符到第一个引号包着的 sn-* 字面量
const feEvents = new Set(
  [...feText.matchAll(/listen[\s\S]{0,200}?['"`](sn-[a-z0-9-]+)['"`]/g)].map((m) => m[1]),
);

// invoke 的命令名：invoke<T>('xxx' | invoke('xxx'，同样容忍跨行
const feCommands = new Set(
  [...feText.matchAll(/invoke\s*(?:<[\s\S]{0,120}?>)?\s*\(\s*['"`]([a-z0-9_]+)['"`]/g)].map(
    (m) => m[1],
  ),
);

/* ---------- 3. 对账 ---------- */

const errors = [];
const warnings = [];

for (const ev of [...feEvents].sort()) {
  if (!rustEvents.has(ev)) {
    errors.push(`事件 ${ev}：前端在 listen，但 Rust 侧没有任何同名发射（拼错或改名漏改？）`);
  }
}
for (const cmd of [...feCommands].sort()) {
  if (!rustCommands.has(cmd)) {
    errors.push(`命令 ${cmd}：前端在 invoke，但未注册进 generate_handler!（运行期必 reject）`);
  }
}
for (const cmd of [...rustCommands].sort()) {
  if (!feCommands.has(cmd)) {
    warnings.push(`命令 ${cmd}：已注册但前端从未调用（预留/遗漏？）`);
  }
}
for (const ev of [...rustEvents].sort()) {
  if (!feEvents.has(ev)) {
    warnings.push(`事件 ${ev}：Rust 有发射但前端从未 listen（预留/遗漏？）`);
  }
}

console.log(`契约对账：事件 Rust ${rustEvents.size} / 前端 ${feEvents.size}，命令 Rust ${rustCommands.size} / 前端 ${feCommands.size}`);
for (const w of warnings) console.log(`::warning::${w}`);
if (errors.length) {
  for (const e of errors) console.error(`::error::${e}`);
  console.error(`\n契约对账失败：${errors.length} 处错误级不对称`);
  process.exit(1);
}
console.log('契约对账通过 ✓');

// 文档相对链接体检：扫描仓库内的 Markdown，检查相对链接能否落到真实文件。
// 用法：node 工具/check-doc-links.mjs
// 排除：.git、node_modules、工具/gen（存放外部文档转储，其中的相对链接天然指向别处）。

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const skipDirs = new Set(['.git', 'node_modules', 'gen']);
const linkRe = /\]\(([^)]+)\)/g;

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.dsh') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      await walk(full, out);
    } else if (entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

const files = await walk(root);
let checked = 0;
const broken = [];

for (const file of files) {
  const text = await readFile(file, 'utf8');
  for (const match of text.matchAll(linkRe)) {
    const raw = match[1].trim();
    if (/^(https?:|mailto:|#)/.test(raw)) continue;
    const target = decodeURI(raw.split('#')[0]);
    if (!target) continue;
    checked += 1;
    if (!(await exists(path.resolve(path.dirname(file), target)))) {
      broken.push(`${path.relative(root, file)} -> ${raw}`);
    }
  }
}

if (broken.length > 0) {
  console.error(`失效链接 ${broken.length} 条：`);
  for (const line of broken) console.error(`  ${line}`);
  process.exitCode = 1;
} else {
  console.log(`文档链接体检通过：${files.length} 份文档，${checked} 条相对链接，0 失效。`);
}

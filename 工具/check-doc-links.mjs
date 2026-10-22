// 文档相对链接体检：扫描仓库内的 Markdown，检查相对链接能否落到真实文件。
// 用法：node 工具/check-doc-links.mjs
// 排除：.git、node_modules、工具/gen、work、dist（外部转储/解包产物里的相对链接
// 天然指向它们自己的包根，不能按本仓库路径判断）。

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const skipDirs = new Set(['.git', 'node_modules', 'gen', 'work', 'dist']);
const linkRe = /\]\(([^)]+)\)/g;

function isGeneratedArtifact(absoluteTarget, target) {
  const normalized = target.replace(/\\/g, '/');
  if (/^(?:\.\.\/)*(?:工具\/gen|work|dist)(?:\/|$)/.test(normalized)) return true;
  const relative = path.relative(root, absoluteTarget).split(path.sep);
  return (
    (relative[0] === '工具' && relative[1] === 'gen') ||
    relative[0] === 'work' ||
    relative[0] === 'dist'
  );
}

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
    const absoluteTarget = path.resolve(path.dirname(file), target);
    if (isGeneratedArtifact(absoluteTarget, target)) continue;
    checked += 1;
    if (!(await exists(absoluteTarget))) {
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

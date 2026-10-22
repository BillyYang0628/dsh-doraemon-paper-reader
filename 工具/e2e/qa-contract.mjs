#!/usr/bin/env node
// B0/B6：把批注问答固定问题集生成人工评分表。
// 真实模型回答与确定性探针由 `工具/qa/evaluate-contract.mjs` 执行。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--fixture') out.fixture = argv[++i]
    else if (argv[i] === '--out') out.out = argv[++i]
    else throw new Error('未知参数：' + argv[i])
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const fixturePath = path.resolve(args.fixture ?? 'test/fixtures/qa-contract-v1.json')
const outDir = path.resolve(args.out ?? '工具/gen/B0-20261021/qa-contract')
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'))
if (!Array.isArray(fixture.cases) || fixture.cases.length === 0) throw new Error('QA fixture 没有 cases')
for (const testCase of fixture.cases) {
  for (const key of ['id', 'prompt', 'expectedFocus', 'critiqueAllowedAtEnd', 'webSearchExpected']) {
    if (!(key in testCase)) throw new Error(testCase.id + ' 缺少字段 ' + key)
  }
}

const lines = [
  '# B0 Annotation Q&A Contract',
  '',
  '## Default contract',
  '',
  ...fixture.defaultContract.map((item) => '- ' + item),
  '',
  '## Cases',
  '',
  '| ID | Prompt | Evidence mode | Source | Expected focus | Critique at end | Web search | Direct answer | Understood/rebuilt | Evidence boundary | Notes |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
  ...fixture.cases.map(
    (item) =>
      `| ${item.id} | ${item.prompt.replace(/\|/g, '\\|')} | ${item.answerPolicy?.evidenceMode || 'allow-external'} | ${
        item.source?.blockId || ''
      } | ${item.expectedFocus.replace(/\|/g, '\\|')} | ${
        item.critiqueAllowedAtEnd ? 'allowed' : 'not default'
      } | ${item.webSearchExpected ? 'expected' : 'not required'} | [ ] | [ ] | [ ] |  |`,
  ),
  '',
  'Scoring: use pass / partial / fail; a case fails if it answers a different question, over-criticizes by default, repeats the source without reconstruction, or blurs paper/external/model boundaries.',
]

await mkdir(outDir, { recursive: true })
await writeFile(path.join(outDir, 'checklist.md'), lines.join('\n') + '\n', 'utf8')
await writeFile(path.join(outDir, 'report.json'), JSON.stringify({ fixture: fixturePath, cases: fixture.cases.length }, null, 2), 'utf8')
console.log(JSON.stringify({ out: outDir, cases: fixture.cases.length }, null, 2))

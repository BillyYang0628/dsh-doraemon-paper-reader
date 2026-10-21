import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve('.')

test('B0 PDF corpus：覆盖 PDF/HTML、双栏、图表、算法和旋转表样本', async () => {
  const corpus = JSON.parse(await readFile(path.join(ROOT, 'test/fixtures/pdf-corpus-v1.json'), 'utf8'))
  assert.equal(corpus.version, 1)
  assert.ok(corpus.sources.length >= 6)
  const ids = corpus.sources.map((source) => source.id)
  assert.equal(new Set(ids).size, ids.length, 'corpus id 必须唯一')

  for (const source of corpus.sources) {
    assert.ok(source.title, source.id + ' 缺少 title')
    assert.match(source.sha256, /^[a-f0-9]{64}$/, source.id + ' SHA-256 形状不对')
    assert.ok(Array.isArray(source.features) && source.features.length > 0)
    assert.ok(Array.isArray(source.focusIssues) && source.focusIssues.length > 0)
  }

  const features = new Set(corpus.sources.flatMap((source) => source.features))
  for (const required of ['algorithm', 'numbered-steps', 'long-table', 'rotated-tables', 'html']) {
    assert.ok(features.has(required), 'corpus 缺少能力样本：' + required)
  }
})

test('B0 AIoT 样本：Algorithm 1 已知失败有 page 与 blockId 事实', async () => {
  const corpus = JSON.parse(await readFile(path.join(ROOT, 'test/fixtures/pdf-corpus-v1.json'), 'utf8'))
  const source = corpus.sources.find((item) => item.id === 'treyni-aiot-2026')
  assert.ok(source)
  assert.equal(source.knownFailure.page, 10)
  assert.deepEqual(source.knownFailure.blocks, ['b0104', 'b0105', 'b0106', 'b0107'])
  assert.match(source.knownFailure.observed, /BEGIN\/END/)
  assert.match(source.knownFailure.observed, /12 pseudo-code steps/)
})

test('B0 QA contract：覆盖直接解释、表格、灵感、明确批判和只读原文', async () => {
  const fixture = JSON.parse(await readFile(path.join(ROOT, 'test/fixtures/qa-contract-v1.json'), 'utf8'))
  assert.equal(fixture.version, 1)
  assert.ok(fixture.defaultContract.length >= 4)
  const ids = fixture.cases.map((item) => item.id)
  for (const required of [
    'term-explanation',
    'method-understanding',
    'figure-table-reading',
    'inspiration-no-direction',
    'explicit-critique',
    'paper-only',
  ]) {
    assert.ok(ids.includes(required), 'QA fixture 缺少：' + required)
  }
  assert.equal(new Set(ids).size, ids.length)
  for (const item of fixture.cases) {
    assert.ok(item.prompt)
    assert.ok(item.expectedFocus)
    assert.equal(typeof item.critiqueAllowedAtEnd, 'boolean')
    assert.equal(typeof item.webSearchExpected, 'boolean')
  }
})

test('B0 工具入口存在，且明确覆盖 navigation / structure / QA / library', () => {
  for (const file of [
    '工具/e2e/navigation-state.mjs',
    '工具/e2e/pdf-structure-audit.mjs',
    '工具/e2e/qa-contract.mjs',
    '工具/e2e/library.mjs',
  ]) {
    assert.ok(existsSync(path.join(ROOT, file)), '缺少 B0 工具：' + file)
  }
})

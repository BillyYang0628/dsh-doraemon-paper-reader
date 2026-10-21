import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  formulaPrompt,
  buildTableTextBatches,
  mergeTableSlices,
  normalizeFormulaResult,
  normalizeTableResult,
  parseRotatedTableGrid,
  tablePrompt,
  visualCacheKey,
} from '../src/visual.js'

test('公式转写：去围栏/美元符并校验括号与置信度', () => {
  const ok = normalizeFormulaResult({
    latex: '```latex\n$$M(t)=\\sqrt{x(t)^2+y(t)^2}$$\n```',
    confidence: 0.9,
    warnings: [],
  })
  assert.equal(ok.latex, 'M(t)=\\sqrt{x(t)^2+y(t)^2}')
  assert.equal(ok.valid, true)
  const bad = normalizeFormulaResult({ latex: 'x=\\frac{1}{', confidence: 0.8 })
  assert.equal(bad.valid, false)
  assert.ok(bad.warnings.includes('unbalanced-braces'))
  assert.match(formulaPrompt({ label: 'Equation 2', page: 6 }), /只返回 JSON/)
})

test('表格译文：行列规范化，数字只允许来自文本层', () => {
  const source = 'Sampling Frequency [Hz] 400 16.869 800 19.204'
  const ok = normalizeTableResult(
    {
      rows: [
        { header: true, cells: ['采样频率 [Hz]', '低功耗模式 [µA]'] },
        { cells: ['400', '16.869'] },
        { cells: ['800', '19.204'] },
      ],
      warnings: [],
    },
    source,
  )
  assert.equal(ok.valid, true)
  assert.equal(ok.rows.length, 3)

  const bad = normalizeTableResult(
    { rows: [{ cells: ['400', '99.999'] }], warnings: [] },
    source,
  )
  assert.equal(bad.valid, false)
  assert.ok(bad.warnings.some((entry) => entry.startsWith('hallucinated-numbers')))
  assert.match(tablePrompt({ label: 'Table 1', page: 4, tableText: source }), /数字/)
})

test('视觉缓存键：同内容稳定，换版本或模型即失效', () => {
  const base = visualCacheKey('formula', { asset: 'a.png' }, 1, 'deepseek-flash')
  assert.equal(base, visualCacheKey('formula', { asset: 'a.png' }, 1, 'deepseek-flash'))
  assert.notEqual(base, visualCacheKey('formula', { asset: 'a.png' }, 2, 'deepseek-flash'))
  assert.notEqual(base, visualCacheKey('formula', { asset: 'a.png' }, 1, 'other'))
})

test('表格分片合并：保留首片表头，正文去重', () => {
  const merged = mergeTableSlices([
    {
      rows: [
        { header: true, cells: ['列 A', '列 B'] },
        { header: false, cells: ['1', '2'] },
        { header: false, cells: ['3', '4'] },
      ],
      warnings: [],
    },
    {
      rows: [
        { header: true, cells: ['列 A', '列 B'] },
        { header: false, cells: ['3', '4'] },
        { header: false, cells: ['5', '6'] },
      ],
      warnings: ['overlap'],
    },
  ])
  assert.deepEqual(merged.rows, [
    { header: true, cells: ['列 A', '列 B'] },
    { header: false, cells: ['1', '2'] },
    { header: false, cells: ['3', '4'] },
    { header: false, cells: ['5', '6'] },
  ])
  assert.deepEqual(merged.warnings, ['overlap'])
})

test('旋转表文本：识别表头并按正文行切批', () => {
  const text = [
    'Table 2. Resistance',
    'Strain Organism State Year Source',
    'A C S Su',
    'N1 S. Newport OR 2004 Beef A C S Su',
    'N2 S. Newport OR 2004 Beef A - S Su',
    'N3 S. Newport OR 2004 Beef A C - Su',
  ].join('\n')
  const batches = buildTableTextBatches(text, { maxRows: 2 })
  assert.equal(batches.length, 2)
  assert.deepEqual(batches[0].headerLines, [
    'Strain Organism State Year Source',
    'A C S Su',
  ])
  assert.equal(batches[0].includeHeader, true)
  assert.equal(batches[1].includeHeader, false)
})

test('旋转表结构化：固定列解析出 32 列并翻译来源', () => {
  const text = [
    'Strain Organism State Year Source Antimicrobial resistance phenotypea IncA/C PCR profileb Transferc',
    'A C S Su T Ti G K Ag Ax N Ak Cp Sxt',
    'N1 S. Newport OR 2004 Beef A C S Su T Ti - - Ag Ax N Ak Cp Sxt 1 2 3 4 5 - - - - 10 11 12 8.4 x 10-6',
  ].join('\n')
  const rows = parseRotatedTableGrid(text)
  assert.equal(rows.length, 3)
  assert.equal(rows[0].cells.length, 32)
  assert.equal(rows[2].cells[0], 'N1')
  assert.equal(rows[2].cells[4], '牛肉')
  assert.equal(rows[2].cells.length, 32)
  assert.equal(rows[2].cells[31], '8.4 x 10-6')
})

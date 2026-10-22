import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCitationIndex,
  buildCitationPrompt,
  buildCitedDigest,
  citationContextHash,
  extractReferenceFields,
  normalizeCitationAnalysis,
  parseCitationNumbers,
  parseCitationSpans,
  referenceNumber,
} from '../src/citations.js'

test('引用编号：单条、逗号与区间展开', () => {
  assert.deepEqual(parseCitationNumbers('12'), [12])
  assert.deepEqual(parseCitationNumbers('3, 5'), [3, 5])
  assert.deepEqual(parseCitationNumbers('3–5'), [3, 4, 5])
  assert.deepEqual(parseCitationNumbers('1,4-6'), [1, 4, 5, 6])
  assert.deepEqual(parseCitationNumbers('5,5,5'), [5])
})

test('引用 span：保留原文偏移与方括号文本', () => {
  const text = 'A [3] and [4–6], but not [x].'
  const spans = parseCitationSpans(text)
  assert.equal(spans.length, 2)
  assert.equal(spans[0].raw, '[3]')
  assert.equal(spans[0].start, 2)
  assert.equal(text.slice(spans[0].start, spans[0].end), '[3]')
  assert.deepEqual(spans[1].numbers, [4, 5, 6])
})

test('引用索引：参考文献编号映射到正文 blockId', () => {
  const blocks = [
    { id: 'b0', type: 'paragraph', text: 'See [1] and [2–3].' },
    { id: 'b1', type: 'reference', text: '1. First paper.' },
    { id: 'b2', type: 'reference', text: '2. Second paper.' },
    { id: 'b3', type: 'reference', text: '3. Third paper.' },
  ]
  const index = buildCitationIndex(blocks)
  assert.equal(index.referenceCount, 3)
  assert.deepEqual(index.byBlock.b0.map((span) => span.raw), ['[1]', '[2–3]'])
  assert.deepEqual(index.byBlock.b0[1].numbers, [2, 3])
  assert.equal(referenceNumber('  [12] Something'), 12)
  assert.equal(referenceNumber('2020 was a year'), 0)
})

test('reference 字段：DOI、年份与标题提示', () => {
  const fields = extractReferenceFields(
    '7. Ntzani EE, Ioannidis JP (2003) Predictive ability of DNA microarrays for cancer outcomes. Lancet 362: 1439–1444. doi:10.1016/S0140-6736(03)14544-3',
  )
  assert.equal(fields.doi, '10.1016/s0140-6736(03)14544-3')
  assert.equal(fields.year, '2003')
  assert.match(fields.title, /Predictive ability/i)
  assert.match(fields.venue, /Lancet/i)
})

test('reference 字段：标题尾部 CoRR/arXiv 编号不进入标题查询', () => {
  const fields = extractReferenceFields(
    'Gema et al. (2024) Are we done with MMLU? CoRR, abs/2406.04127, 2024. URL https://doi.org/10.48550/arXiv.2406.04127.',
  )
  assert.equal(fields.title, 'Are we done with MMLU?')
  assert.equal(fields.arxiv, '2406.04127')
})

test('reference 字段：作者姓名列表不会被误认成标题', () => {
  const fields = extractReferenceFields(
    'Mattern et al. (2023) Justus Mattern, Fatemehsadat Mireshghallah, Zhijing Jin, Bernhard Schoelkopf, Mrinmaya Sachan, and Taylor Berg-Kirkpatrick. 2023. Membership Inference Attacks against Language Models via Neighbourhood Comparison. In Findings of ACL 2023.',
  )
  assert.match(fields.title, /Membership Inference Attacks/)
  assert.doesNotMatch(fields.title, /^Justus Mattern/)
})

test('reference 字段：arXiv preprint 占位句不会覆盖真实标题', () => {
  const fields = extractReferenceFields(
    'Lightman et al. (2023) H. Lightman, V. Kosaraju, Y. Burda. Let’s verify step by step. arXiv preprint arXiv:2305.20050, 2023.',
  )
  assert.equal(fields.title, 'Let’s verify step by step')
  assert.equal(fields.arxiv, '2305.20050')
})

test('被引摘要：优先全文段落，缺全文时退回摘要', () => {
  const withText = buildCitedDigest({
    doc: {
      meta: { title: 'Cited', abstract: 'Short abstract.' },
      blocks: [
        { type: 'heading', text: 'Methods' },
        { type: 'paragraph', text: 'We did a thing.' },
        { type: 'paragraph', text: 'We did another thing.' },
        { type: 'paragraph', text: 'This third paragraph is still included.' },
        { type: 'paragraph', text: 'This fourth paragraph should be omitted.' },
      ],
    },
  })
  assert.equal(withText.basis, 'full-text')
  assert.match(withText.text, /We did a thing/)
  assert.match(withText.text, /third paragraph is still included/)
  assert.doesNotMatch(withText.text, /fourth paragraph should be omitted/)
  const abstractOnly = buildCitedDigest({ summary: { title: 'X', abstract: 'Only abstract.' } })
  assert.equal(abstractOnly.basis, 'abstract')
  assert.match(abstractOnly.text, /Only abstract/)
})

test('模型输出规范化：固定字段、过滤未知 stance', () => {
  const normalized = normalizeCitationAnalysis({
    overview: { question: 'Q', method: 'M', findings: 'F' },
    relation: {
      stance: 'supports',
      summary: 'S',
      points: [{ claim: 'C', citingEvidence: 'CE', citedEvidence: 'DE' }],
    },
    warnings: ['基于摘要'],
  })
  assert.equal(normalized.overview.question, 'Q')
  assert.equal(normalized.overview.limitations, '')
  assert.equal(normalized.relation.stance, 'supports')
  assert.equal(normalized.relation.points[0].citedEvidence, 'DE')
  assert.equal(normalizeCitationAnalysis({ relation: { stance: 'made-up' } }).relation.stance, 'unclear')
})

test('引用提示词同时带上引用处与被引论文两侧材料', () => {
  const prompt = buildCitationPrompt({
    referenceText: '1. A cited paper.',
    number: 1,
    citing: { quote: 'The citing sentence [1].', paperTitle: 'Citing' },
    digest: { text: 'Cited paper text.', basis: 'full-text' },
  })
  assert.match(prompt.user, /引用处原文/)
  assert.match(prompt.user, /被引论文材料/)
  assert.match(prompt.user, /Cited paper text/)
  assert.match(prompt.system, /引用者的主张/)
})

test('引用上下文哈希：稳定且随上下文变化', () => {
  const base = { jobId: 'j', blockId: 'b', quote: 'q', number: 1, referenceText: 'r' }
  assert.equal(citationContextHash(base), citationContextHash({ ...base }))
  assert.notEqual(citationContextHash(base), citationContextHash({ ...base, quote: 'q2' }))
  assert.notEqual(citationContextHash(base), citationContextHash({ ...base, referenceKey: 'candidate-2' }))
})

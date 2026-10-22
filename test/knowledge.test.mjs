import test from 'node:test'
import assert from 'node:assert/strict'

import {
  annotationsToJson,
  annotationsToMarkdown,
  buildCitationGraph,
  buildKnowledgeProfile,
  citationsToMarkdown,
  createKnowledgeEntry,
  glossaryToCsv,
  groupKnowledgeResults,
  knowledgeFacets,
  knowledgeQueryTerms,
  searchKnowledge,
} from '../src/knowledge.js'

const entries = [
  createKnowledgeEntry({
    sourceType: 'text',
    jobId: 'job-aaaaaaaa',
    blockId: 'a101',
    page: 2,
    section: 'Methods',
    paperTitle: 'MobileViT for Plant Disease',
    title: 'MobileViT method',
    authors: 'A. Author',
    doi: '10.1/a',
    text: 'A lightweight MobileViT detects plant disease on edge devices.',
    updatedAt: '2026-10-22T01:00:00.000Z',
  }),
  createKnowledgeEntry({
    sourceType: 'annotation',
    jobId: 'job-aaaaaaaa',
    blockId: 'a101',
    page: 2,
    section: 'Methods',
    paperTitle: 'MobileViT for Plant Disease',
    title: '批注：MobileViT',
    text: '用户问 MobileViT 在真实农场的部署限制。',
    updatedAt: '2026-10-22T02:00:00.000Z',
  }),
  createKnowledgeEntry({
    sourceType: 'term',
    jobId: 'job-bbbbbbbb',
    blockId: 'b201',
    page: 5,
    section: 'Experiments',
    paperTitle: 'Smart Sticker Shock Detection',
    title: '术语 MobileViT',
    text: 'MobileViT 是轻量视觉 transformer。',
    updatedAt: '2026-10-22T03:00:00.000Z',
  }),
]

test('知识索引：中文/英文查询词都能召回，并保留 blockId', () => {
  assert.ok(knowledgeQueryTerms('MobileViT 植物病害').includes('mobilevit'))
  const result = searchKnowledge(entries, { query: 'MobileViT 病害', limit: 10 })
  assert.equal(result.results.length, 3)
  assert.ok(result.results.every((item) => item.jobId && item.blockId))
  assert.match(result.results[0].snippet, /MobileViT|病害/)
  const grouped = groupKnowledgeResults(result.results)
  assert.equal(grouped[0].jobId, 'job-aaaaaaaa')
  assert.equal(grouped[0].items.length, 2)
})

test('知识索引：来源过滤与 facet 计数', () => {
  const result = searchKnowledge(entries, {
    query: 'MobileViT',
    sourceTypes: ['annotation'],
  })
  assert.equal(result.results.length, 1)
  assert.equal(result.results[0].sourceType, 'annotation')
  assert.deepEqual(knowledgeFacets(entries), {
    total: 3,
    papers: 2,
    byType: {
      text: 1,
      annotation: 1,
      translation: 0,
      term: 1,
      citation: 0,
      qa: 0,
      report: 0,
    },
  })
})

test('引用图谱：出边标明本地命中，入边只来自本地论文', () => {
  const library = [
    { jobId: 'job-aaaaaaaa', title: 'MobileViT for Plant Disease', doi: '10.1/a' },
    { jobId: 'job-bbbbbbbb', title: 'Smart Sticker', doi: '10.1/b' },
  ]
  const graph = buildCitationGraph({
    centerJobId: 'job-aaaaaaaa',
    center: library[0],
    library,
    references: [
      { number: 1, title: 'Smart Sticker', doi: '10.1/b', blockId: 'a900' },
      { number: 2, title: 'External paper', doi: '10.1/x', blockId: 'a901' },
    ],
    incomingReferences: [
      { citingJobId: 'job-bbbbbbbb', number: 3, blockId: 'b900' },
      { citingJobId: 'job-bbbbbbbb', number: 4, blockId: 'b901' },
    ],
  })
  assert.equal(graph.coverage.outgoing, 2)
  assert.equal(graph.coverage.outgoingLocal, 1)
  assert.equal(graph.coverage.incomingLocal, 1)
  assert.equal(graph.coverage.incomingLocalReferences, 2)
  assert.ok(graph.nodes.some((node) => node.localJobId === 'job-bbbbbbbb'))
  assert.ok(graph.edges.every((edge) => edge.grounded))
})

test('阅读档案：聚合时长、待发送批注和复核问题', () => {
  const profile = buildKnowledgeProfile({
    library: [
      { jobId: 'job-aaaaaaaa', title: 'A' },
      { jobId: 'job-bbbbbbbb', title: 'B' },
    ],
    profile: {
      jobs: {
        'job-aaaaaaaa': {
          readingSeconds: 120,
          lastReadAt: '2026-10-22T02:00:00.000Z',
          lastBlockId: 'a101',
          lastPage: 2,
          visitedBlockIds: ['a100', 'a101'],
        },
      },
    },
    annotationsByJob: {
      'job-aaaaaaaa': { count: 3, pending: 1 },
    },
    reviewByJob: { 'job-bbbbbbbb': 2 },
    archives: [{ id: 'archive-1' }],
  })
  assert.equal(profile.totalReadingSeconds, 120)
  assert.equal(profile.papersRead, 1)
  assert.equal(profile.pendingAnnotations, 1)
  assert.equal(profile.reviewPending, 2)
  assert.equal(profile.nextActions.length, 2)
})

test('导出格式：批注、术语 CSV 和引用汇总带完整性告警', () => {
  const items = [
    {
      id: 'ann-1',
      question: '这个方法能复用吗？',
      segments: [{ blockId: 'a101', page: 2, section: 'Methods', quote: 'MobileViT text' }],
    },
    {
      id: 'ann-2',
      question: '没有锚点',
      segments: [],
    },
  ]
  const markdown = annotationsToMarkdown({
    jobId: 'job-aaaaaaaa',
    paper: { title: 'Paper A' },
    items,
  })
  assert.match(markdown.markdown, /a101/)
  assert.match(markdown.warnings.join('；'), /没有原文片段/)

  const json = annotationsToJson({ jobId: 'job-aaaaaaaa', paper: { title: 'Paper A' }, items })
  assert.ok(json.warnings.length > 0)
  assert.equal(JSON.parse(json.json).items.length, 2)

  const csv = glossaryToCsv([{ source: 'MobileViT', target: '轻量视觉模型', kind: 'term', count: 3, locked: true, firstBlockId: 'a101' }])
  assert.match(csv, /source,target/)
  assert.match(csv, /"MobileViT"/)

  const citations = citationsToMarkdown({
    jobId: 'job-aaaaaaaa',
    paper: { title: 'Paper A' },
    references: [{ title: 'Ref', doi: '10.1/r', blockId: 'a900' }],
    analyses: [{ title: 'Ref analysis', basis: 'metadata' }],
  })
  assert.match(citations, /a900/)
  assert.match(citations, /metadata/)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  cleanOriginalName,
  contentTypeFor,
  isPdfBuffer,
  routeRequest,
  safeJobFile,
} from '../src/papers.js'

test('PDF 入口：文件名只留 basename，并补 .pdf', () => {
  assert.equal(cleanOriginalName('..\\..\\论文.pdf'), '论文.pdf')
  assert.equal(cleanOriginalName('paper'), 'paper.pdf')
  assert.equal(cleanOriginalName('a<b>.pdf'), 'a_b_.pdf')
  assert.equal(cleanOriginalName(encodeURIComponent('带 空格.pdf')), '带 空格.pdf')
})

test('PDF 入口：只认 %PDF- 魔数', () => {
  assert.equal(isPdfBuffer(Buffer.from('%PDF-1.7\n')), true)
  assert.equal(isPdfBuffer(Buffer.from('not a pdf')), false)
  assert.equal(isPdfBuffer(Buffer.alloc(0)), false)
})

test('API 路由：状态、文件、资产与非法路径', () => {
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/import'), { type: 'import' })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/open'), { type: 'citation-open' })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/library'), { type: 'library' })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/knowledge'), { type: 'knowledge' })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/knowledge/search'), {
    type: 'knowledge-search',
  })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/knowledge/rebuild'), {
    type: 'knowledge-rebuild',
  })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/knowledge/profile'), {
    type: 'knowledge-profile',
  })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/knowledge/progress'), {
    type: 'knowledge-progress',
  })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/knowledge/qa'), {
    type: 'knowledge-qa',
  })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/library/import'), { type: 'library-import' })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/library/convert'), { type: 'library-convert' })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/library/trash'), { type: 'library-trash' })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/library/restore'), { type: 'library-restore' })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/maintenance'), { type: 'maintenance' })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/maintenance/python'), {
    type: 'maintenance-python',
  })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/maintenance/cleanup'), {
    type: 'maintenance-cleanup',
  })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/jobs/abcdefgh/annotations'), {
    type: 'annotations',
    jobId: 'abcdefgh',
  })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/jobs/abcdefgh'), {
    type: 'status',
    jobId: 'abcdefgh',
  })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/jobs/abcdefgh/convert'), {
    type: 'job-convert',
    jobId: 'abcdefgh',
  })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/jobs/abcdefgh/citation-graph'), {
    type: 'citation-graph',
    jobId: 'abcdefgh',
  })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/jobs/abcdefgh/export'), {
    type: 'job-export',
    jobId: 'abcdefgh',
  })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/jobs/abcdefgh/citations'), {
    type: 'citation-index',
    jobId: 'abcdefgh',
  })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/jobs/abcdefgh/translate'), {
    type: 'translation',
    jobId: 'abcdefgh',
  })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/jobs/abcdefgh/review/decisions'), {
    type: 'translation-review-decision',
    jobId: 'abcdefgh',
  })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/jobs/abcdefgh/translations'), {
    type: 'translations-file',
    jobId: 'abcdefgh',
  })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/jobs/abcdefgh/formulas/b0001'), {
    type: 'formula-block',
    jobId: 'abcdefgh',
    blockId: 'b0001',
  })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/jobs/abcdefgh/glossary'), {
    type: 'glossary',
    jobId: 'abcdefgh',
  })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/jobs/abcdefgh/term-lookup'), {
    type: 'term-lookup',
    jobId: 'abcdefgh',
  })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/jobs/abcdefgh/version'), {
    type: 'version',
    jobId: 'abcdefgh',
  })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/jobs/abcdefgh/cancel-task'), {
    type: 'cancel-task',
    jobId: 'abcdefgh',
  })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/citations/resolve'), { type: 'citation-resolve' })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/citations/analyze'), { type: 'citation-analyze' })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/citations/promote'), { type: 'citation-promote' })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/compare/concept'), { type: 'compare-concept' })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/compare/survey-report'), {
    type: 'compare-survey-report',
  })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/jobs/abcdefgh/mirrordoc.json'), {
    type: 'file',
    jobId: 'abcdefgh',
    file: 'mirrordoc.json',
  })
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/jobs/abcdefgh/assets/figure-01.png'), {
    type: 'asset',
    jobId: 'abcdefgh',
    folder: 'assets',
    name: 'figure-01.png',
  })
  assert.notEqual(routeRequest('/doraemon-paper-reader/api/jobs/../x')?.type, 'asset')
  assert.notEqual(routeRequest('/doraemon-paper-reader/api/jobs/abcdefgh/assets/../../x')?.type, 'asset')
  assert.equal(routeRequest('/other'), null)
})

test('API 文件路径：落在 job 目录内', () => {
  const root = path.resolve('tools', 'jobs', 'abcdefgh')
  assert.equal(
    safeJobFile(root, { type: 'file', file: 'mirrordoc.json' }),
    path.join(root, 'mirrordoc.json'),
  )
  assert.equal(
    safeJobFile(root, { type: 'asset', folder: 'assets', name: 'figure-01.png' }),
    path.join(root, 'assets', 'figure-01.png'),
  )
  assert.equal(safeJobFile(root, { type: 'file', file: '../secret' }), null)
  assert.equal(safeJobFile(root, { type: 'asset', folder: 'assets', name: '../secret' }), null)
})

test('API 文件类型', () => {
  assert.match(contentTypeFor('a.json'), /application\/json/)
  assert.match(contentTypeFor('a.html'), /text\/html/)
  assert.equal(contentTypeFor('a.png'), 'image/png')
})

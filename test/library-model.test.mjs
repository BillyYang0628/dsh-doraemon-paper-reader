import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createLibraryEntry,
  groupLibraryItems,
  libraryGroupKey,
  normalizeLibraryEntry,
  normalizeLibraryStatus,
} from '../src/library.js'

test('文档库状态：旧状态与未知状态稳定收敛', () => {
  assert.equal(normalizeLibraryStatus('done'), 'ready')
  assert.equal(normalizeLibraryStatus('running'), 'converting')
  assert.equal(normalizeLibraryStatus('queued'), 'queued')
  assert.equal(normalizeLibraryStatus('garbage', 'failed'), 'failed')
  assert.equal(normalizeLibraryStatus('garbage'), 'imported')
})

test('文档库模型：manifest 补齐缺省字段且不伪造 ready', () => {
  const entry = createLibraryEntry({
    jobId: 'abcdefgh',
    originalName: 'paper.pdf',
    sha256: 'ABCDEF',
    bytes: 12,
    status: 'imported',
    artifacts: { originalPdf: true },
  })
  assert.equal(entry.sha256, 'abcdef')
  assert.equal(entry.status, 'imported')
  assert.equal(entry.readyAt, '')
  assert.equal(entry.artifacts.originalPdf, true)
  assert.equal(entry.artifacts.mirrorDoc, false)

  const normalized = normalizeLibraryEntry({ jobId: 'abcdefgh', metadata: { authors: ['A', 'B'] } })
  assert.equal(normalized.metadata.authors, 'A, B')
  assert.equal(normalized.status, 'imported')
})

test('版本分组：DOI/arXiv/标题/哈希逐级回退', () => {
  assert.equal(libraryGroupKey({ doi: '10.1/X' }), 'doi:10.1/x')
  assert.equal(libraryGroupKey({ arxiv: '2401.00001' }), 'arxiv:2401.00001')
  assert.equal(libraryGroupKey({ title: '  A   Paper ' }), 'title:a paper')
  assert.equal(libraryGroupKey({ sha256: 'ABC' }), 'sha256:abc')
  assert.equal(libraryGroupKey({ jobId: 'abcdefgh' }), 'job:abcdefgh')
})

test('版本分组：保留所有物理文件，ready 优先作为主条目', () => {
  const groups = groupLibraryItems([
    {
      jobId: 'aaaaaaaa',
      title: 'Test Paper',
      status: 'failed',
      annotationCount: 9,
      updatedAt: '2026-10-22T10:00:00.000Z',
    },
    {
      jobId: 'bbbbbbbb',
      title: 'Test Paper',
      status: 'ready',
      annotationCount: 1,
      updatedAt: '2026-10-22T09:00:00.000Z',
    },
    {
      jobId: 'cccccccc',
      title: 'Other Paper',
      status: 'imported',
      updatedAt: '2026-10-22T08:00:00.000Z',
    },
  ])
  assert.equal(groups.length, 2)
  const paper = groups.find((group) => group.key === 'title:test paper')
  assert.equal(paper.count, 2)
  assert.equal(paper.primaryJobId, 'bbbbbbbb')
  assert.deepEqual(
    paper.items.map((item) => item.jobId),
    ['bbbbbbbb', 'aaaaaaaa'],
  )
})

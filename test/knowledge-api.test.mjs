import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { createAnnotationBatchStore } from '../src/annotations.js'
import { createPaperApi } from '../src/papers.js'

const JOB_A = 'job-aaaaaaaa'
const JOB_B = 'job-bbbbbbbb'

function call(handler, method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])
  req.method = method
  req.url = url
  req.headers = {}
  return new Promise((resolve, reject) => {
    const chunks = []
    const res = {
      status: 0,
      headers: {},
      writeHead(status, headers = {}) {
        this.status = status
        this.headers = headers
      },
      end(chunk) {
        if (chunk !== undefined) chunks.push(Buffer.from(chunk))
        const text = Buffer.concat(chunks).toString('utf8')
        try {
          resolve({ status: this.status, headers: this.headers, body: text ? JSON.parse(text) : null })
        } catch (cause) {
          reject(cause)
        }
      },
    }
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

function callText(handler, method, url) {
  const req = Readable.from([])
  req.method = method
  req.url = url
  req.headers = {}
  return new Promise((resolve, reject) => {
    const chunks = []
    const res = {
      status: 0,
      headers: {},
      writeHead(status, headers = {}) {
        this.status = status
        this.headers = headers
      },
      end(chunk) {
        if (chunk !== undefined) chunks.push(Buffer.from(chunk))
        resolve({ status: this.status, headers: this.headers, text: Buffer.concat(chunks).toString('utf8') })
      },
    }
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

function doc(title, doi, paragraphs, references = []) {
  return {
    meta: {
      title,
      authors: 'A. Author',
      doi,
      abstract: title + ' studies MobileViT on edge devices.',
    },
    blocks: [
      { id: paragraphs[0][0], type: 'heading', text: paragraphs[0][1], page: 1, section: paragraphs[0][1] },
      ...paragraphs.slice(1).map(([id, text], index) => ({
        id,
        type: 'paragraph',
        text,
        page: index + 2,
        section: paragraphs[0][1],
      })),
      ...references.map(([id, text, number]) => ({
        id,
        type: 'reference',
        text,
        number,
        page: 9,
        section: 'References',
      })),
    ],
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dpr-knowledge-'))
  const dirA = path.join(root, 'jobs', JOB_A)
  const dirB = path.join(root, 'jobs', JOB_B)
  await Promise.all([mkdir(dirA, { recursive: true }), mkdir(dirB, { recursive: true })])
  const paperA = doc(
    'MobileViT for Plant Disease',
    '10.1000/a',
    [
      ['a100', 'Methods'],
      ['a101', 'MobileViT detects plant disease on edge devices with a lightweight vision model.'],
    ],
    [['a900', '2. B. Author. Smart Sticker. 2025. doi:10.1000/b', 2]],
  )
  const paperB = doc(
    'Smart Sticker Shock Detection',
    '10.1000/b',
    [
      ['b100', 'System'],
      ['b101', 'A low-power sensor detects package shock in the supply chain.'],
    ],
    [['b900', '1. A. Author. MobileViT for Plant Disease. 2026. doi:10.1000/a', 1]],
  )
  await writeFile(path.join(dirA, 'mirrordoc.json'), JSON.stringify(paperA, null, 2), 'utf8')
  await writeFile(path.join(dirB, 'mirrordoc.json'), JSON.stringify(paperB, null, 2), 'utf8')
  await writeFile(
    path.join(dirA, 'paper-summary.json'),
    JSON.stringify({ title: paperA.meta.title, authors: paperA.meta.authors, identifiers: { doi: '10.1000/a', arxiv: '' } }),
    'utf8',
  )
  await writeFile(
    path.join(dirB, 'paper-summary.json'),
    JSON.stringify({ title: paperB.meta.title, authors: paperB.meta.authors, identifiers: { doi: '10.1000/b', arxiv: '' } }),
    'utf8',
  )
  await writeFile(
    path.join(dirA, 'annotations.json'),
    JSON.stringify({
      version: 1,
      jobId: JOB_A,
      updatedAt: '2026-10-22T03:00:00.000Z',
      items: [
        {
          id: 'ann-1',
          jobId: JOB_A,
          sent: false,
          question: '这个 MobileViT 方法能复用吗？',
          segments: [{ blockId: 'a101', page: 2, section: 'Methods', quote: 'MobileViT detects plant disease' }],
        },
      ],
    }),
    'utf8',
  )
  await writeFile(
    path.join(dirA, 'translations.zh.json'),
    JSON.stringify({
      meta: { title: '面向植物病害的 MobileViT', abstract: 'MobileViT 用于边缘设备。' },
      blocks: {
        a101: { text: 'MobileViT 在边缘设备上检测植物病害。', source: 'MobileViT detects...', type: 'paragraph' },
      },
      review: { pending: 1 },
    }),
    'utf8',
  )
  await writeFile(
    path.join(dirA, 'glossary.json'),
    JSON.stringify({
      version: 1,
      entries: [
        { id: 'g1', source: 'MobileViT', target: '轻量视觉模型', kind: 'term', count: 3, firstBlockId: 'a101' },
      ],
    }),
    'utf8',
  )
  const annotations = createAnnotationBatchStore({ dataRoot: root })
  const api = createPaperApi({
    packageRoot: process.cwd(),
    dataRoot: root,
    annotations,
    chatTextImpl: async ({ user }) => '回答：' + String(user).match(/问题：([^\n]+)/)?.[1] + ' [P1 a101]',
  })
  return { root, api }
}

test('知识 API：建索引、跨论文搜索并保留 blockId', async () => {
  const { root, api } = await fixture()
  try {
    const status = await call(api.handler, 'GET', '/doraemon-paper-reader/api/knowledge')
    assert.equal(status.status, 200)
    assert.equal(status.body.stats.papers, 2)
    assert.ok(status.body.stats.total > 0)

    const search = await call(api.handler, 'POST', '/doraemon-paper-reader/api/knowledge/search', {
      query: 'MobileViT 植物病害',
      limit: 20,
    })
    assert.equal(search.status, 200)
    assert.ok(search.body.results.length >= 3)
    assert.ok(search.body.results.every((item) => item.jobId && item.sourceType))
    assert.ok(search.body.groups.some((group) => group.jobId === JOB_A))
    assert.ok(search.body.results.some((item) => item.sourceType === 'annotation'))

    const filtered = await call(api.handler, 'POST', '/doraemon-paper-reader/api/knowledge/search', {
      query: 'MobileViT',
      sourceTypes: ['term'],
    })
    assert.equal(filtered.body.results.length, 1)
    assert.equal(filtered.body.results[0].sourceType, 'term')
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('知识索引：批注文件变化后无需手动 rebuild 即可刷新', async () => {
  const { root, api } = await fixture()
  try {
    await call(api.handler, 'GET', '/doraemon-paper-reader/api/knowledge')
    const annotationsPath = path.join(root, 'jobs', JOB_A, 'annotations.json')
    await writeFile(
      annotationsPath,
      JSON.stringify({
        version: 1,
        jobId: JOB_A,
        updatedAt: '2026-10-22T03:10:00.000Z',
        items: [
          {
            id: 'ann-new',
            jobId: JOB_A,
            sent: false,
            question: 'freshneedle 这个新批注是否已经索引？',
            segments: [{ blockId: 'a101', page: 2, section: 'Methods', quote: 'MobileViT' }],
          },
        ],
      }),
      'utf8',
    )
    const search = await call(api.handler, 'POST', '/doraemon-paper-reader/api/knowledge/search', {
      query: 'freshneedle',
      sourceTypes: ['annotation'],
    })
    assert.equal(search.status, 200)
    assert.equal(search.body.results.length, 1)
    assert.equal(search.body.results[0].blockId, 'a101')
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('知识 API：证据问答只返回带锚点来源', async () => {
  const { root, api } = await fixture()
  try {
    const answer = await call(api.handler, 'POST', '/doraemon-paper-reader/api/knowledge/answer', {
      question: 'MobileViT 用在什么任务？',
      sourceTypes: ['text', 'annotation'],
    })
    assert.equal(answer.status, 200)
    assert.match(answer.body.answer, /\[P1 a101\]/)
    assert.ok(answer.body.sources.length > 0)
    assert.ok(answer.body.sources.every((item) => item.blockId))
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('引用图谱：本地出边与入边都可追溯', async () => {
  const { root, api } = await fixture()
  try {
    const graph = await call(
      api.handler,
      'GET',
      '/doraemon-paper-reader/api/jobs/' + JOB_A + '/citation-graph',
    )
    assert.equal(graph.status, 200)
    assert.equal(graph.body.coverage.outgoing, 1)
    assert.equal(graph.body.coverage.outgoingLocal, 1)
    assert.equal(graph.body.coverage.incomingLocal, 1)
    assert.ok(graph.body.edges.some((edge) => edge.type === 'references' && edge.blockId === 'a900'))
    assert.ok(graph.body.edges.some((edge) => edge.type === 'cites-current' && edge.blockId === 'b900'))
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('阅读档案 API：累计时长并聚合待发送批注与复核问题', async () => {
  const { root, api } = await fixture()
  try {
    const progress = await call(api.handler, 'POST', '/doraemon-paper-reader/api/knowledge/progress', {
      jobId: JOB_A,
      activeSeconds: 30,
      blockId: 'a101',
      page: 2,
      section: 'Methods',
    })
    assert.equal(progress.status, 200)
    const profile = await call(
      api.handler,
      'GET',
      '/doraemon-paper-reader/api/knowledge/profile',
    )
    assert.equal(profile.status, 200)
    assert.ok(profile.body.totalReadingSeconds >= 30)
    assert.equal(profile.body.pendingAnnotations, 1)
    assert.equal(profile.body.reviewPending, 1)
    assert.ok(profile.body.papers.some((paper) => paper.jobId === JOB_A && paper.lastBlockId === 'a101'))
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('知识 API：对照问答自动进入 QA 索引', async () => {
  const { root, api } = await fixture()
  try {
    const saved = await call(api.handler, 'POST', '/doraemon-paper-reader/api/knowledge/qa', {
      jobIds: [JOB_A, JOB_B],
      mode: 'survey',
      question: 'freshanswer 两篇论文能否互证？',
      answer: '不能直接互证，任务不同。[P1 a101] [P2 b101]',
    })
    assert.equal(saved.status, 201)
    const search = await call(api.handler, 'POST', '/doraemon-paper-reader/api/knowledge/search', {
      query: 'freshanswer',
      sourceTypes: ['qa'],
    })
    assert.equal(search.status, 200)
    assert.equal(search.body.results.length, 1)
    assert.equal(search.body.results[0].sourceType, 'qa')
    assert.deepEqual(search.body.results[0].metadata.jobIds, [JOB_A, JOB_B])
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('导出 API：批注 Markdown/JSON、术语 CSV 与引用汇总', async () => {
  const { root, api } = await fixture()
  try {
    const markdown = await callText(
      api.handler,
      'GET',
      '/doraemon-paper-reader/api/jobs/' + JOB_A + '/export?kind=annotations-md',
    )
    assert.equal(markdown.status, 200)
    assert.match(markdown.text, /MobileViT 方法能复用/)
    assert.match(markdown.text, /a101/)

    const json = await callText(
      api.handler,
      'GET',
      '/doraemon-paper-reader/api/jobs/' + JOB_A + '/export?kind=annotations-json',
    )
    assert.equal(JSON.parse(json.text).items.length, 1)

    const glossary = await callText(
      api.handler,
      'GET',
      '/doraemon-paper-reader/api/jobs/' + JOB_A + '/export?kind=glossary-csv',
    )
    assert.match(glossary.text, /MobileViT/)
    assert.match(glossary.text, /轻量视觉模型/)

    const citations = await callText(
      api.handler,
      'GET',
      '/doraemon-paper-reader/api/jobs/' + JOB_A + '/export?kind=citations-md',
    )
    assert.match(citations.text, /Smart Sticker/)
    assert.match(citations.text, /a900/)
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

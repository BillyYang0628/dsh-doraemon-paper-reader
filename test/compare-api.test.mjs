// L0/L1：多篇对照 API（档案、对照表、引用关系、主对话包）。
//
// 模型用假上游，不烧真 key；真实模型与界面在 L2 单独跑。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
      writeHead(status) {
        this.status = status
      },
      end(chunk) {
        if (chunk !== undefined) chunks.push(Buffer.from(chunk))
        const text = Buffer.concat(chunks).toString('utf8')
        try {
          resolve({ status: this.status, body: text ? JSON.parse(text) : null })
        } catch (cause) {
          reject(cause)
        }
      },
    }
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

function doc(title, headingId, textId, text) {
  return {
    meta: {
      title,
      authors: 'A. Author',
      abstract: title + ' studies a sensor in a long enough abstract for the digest to keep.',
    },
    blocks: [
      { id: headingId, type: 'heading', text: 'Introduction', section: 'Introduction', page: 1 },
      { id: textId, type: 'paragraph', text, section: 'Introduction', page: 2 },
    ],
  }
}

function failingChild(message) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  queueMicrotask(() => {
    child.stderr.emit('data', Buffer.from(message))
    child.emit('close', 1)
  })
  return child
}

async function fixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dpr-compare-'))
  for (const [jobId, title, headingId, textId, text] of [
    [JOB_A, 'Paper A', 'a100', 'a101', 'Paper A measures a sensor with a long enough paragraph for the digest gate.'],
    [JOB_B, 'Paper B', 'b100', 'b101', 'Paper B measures vibration with a long enough paragraph for the digest gate.'],
  ]) {
    const dir = path.join(root, 'jobs', jobId)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'mirrordoc.json'), JSON.stringify(doc(title, headingId, textId, text)), 'utf8')
  }
  let chatCalls = 0
  const chatJsonImpl = options.chatJsonImpl || (async ({ system }) => {
    chatCalls += 1
    if (String(system).includes('引用链')) {
      return {
        verdict: 'partially',
        claim: 'A says B measured the same range.',
        citedContribution: 'B measured vibration.',
        gap: 'B does not report the same range.',
        evidence: [{ blockId: 'b101', quote: 'Paper B measures vibration' }],
        nextSection: 'Results',
      }
    }
    if (String(system).includes('概念图规划器')) {
      return {
        title: '方法概念图',
        summary: '原文事实与模型归纳分开。',
        nodes: [
          {
            id: 'n1',
            label: 'A 的测量对象',
            detail: '论文 A 研究传感器。',
            kind: 'method',
            source: {
              jobId: JOB_A,
              blockId: 'a101',
              quote: 'Paper A measures a sensor',
            },
          },
          {
            id: 'n2',
            label: '跨论文迁移风险',
            detail: '两篇对象不同，不能直接假设方法可迁移。',
            kind: 'synthesis',
          },
        ],
        edges: [{ from: 'n1', to: 'n2', label: '需要验证' }],
      }
    }
    if (String(system).includes('即时术语解释器')) {
      return {
        kind: 'word',
        expanded: '',
        contextMeaning: '本文中的传感器测量对象。',
        generalMeaning: '传感器',
        roleInSentence: '作 measures 的宾语。',
        confidence: 'high',
        warnings: [],
      }
    }
    return {
      papers: [
        { jobId: JOB_A, fields: { question: { text: 'A question', blockIds: ['a101'] } } },
        { jobId: JOB_B, fields: { question: { text: 'B question', blockIds: ['b101'] } } },
      ],
      notes: ['fake'],
    }
  })
  const annotations = createAnnotationBatchStore({ dataRoot: root })
  const api = createPaperApi({
    packageRoot: process.cwd(),
    dataRoot: root,
    annotations,
    chatJsonImpl,
    chatTextImpl: async ({ user }) => '工作台回答：' + String(user).split('当前问题：').pop().slice(0, 40),
  })
  return { root, api, chatCalls: () => chatCalls }
}

test('对照 API：档案带 blockId，引用方原文由宿主读回', async () => {
  const { root, api } = await fixture()
  try {
    const digests = await call(api.handler, 'POST', '/doraemon-paper-reader/api/compare/digests', {
      jobIds: [JOB_A, JOB_B],
      citing: { jobId: JOB_A, blockId: 'a101', number: 12, title: 'Paper A' },
    })
    assert.equal(digests.status, 200)
    assert.equal(digests.body.digests.length, 2)
    assert.equal(digests.body.digests[0].sections[0].blockId, 'a100')
    assert.ok(digests.body.digests[0].excerpts.some((excerpt) => excerpt.blockId === 'a101'))
    assert.equal(digests.body.citing.blockId, 'a101')
    assert.match(digests.body.citing.text, /Paper A measures/)
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('公式 SVG：渲染器不可用时保留缓存并降级，不返回 500', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dpr-formula-fallback-'))
  const jobDir = path.join(root, 'jobs', JOB_A)
  await mkdir(path.join(jobDir, 'assets'), { recursive: true })
  await writeFile(
    path.join(jobDir, 'mirrordoc.json'),
    JSON.stringify(doc('Paper A', 'a100', 'a101', 'Paper A measures a sensor with enough text.')),
    'utf8',
  )
  await writeFile(
    path.join(jobDir, 'assets', 'formula-renders.json'),
    JSON.stringify({
      a101: { ok: true, file: 'assets/formula-a101.svg', hash: 'cached' },
    }),
    'utf8',
  )
  const annotations = createAnnotationBatchStore({ dataRoot: root })
  const api = createPaperApi({
    packageRoot: process.cwd(),
    dataRoot: root,
    annotations,
    spawnImpl: () => failingChild('ModuleNotFoundError: No module named matplotlib'),
  })
  try {
    const response = await call(
      api.handler,
      'POST',
      '/doraemon-paper-reader/api/jobs/' + JOB_A + '/formula-render',
    )
    assert.equal(response.status, 200)
    assert.equal(response.body.renders.a101.ok, true)
    assert.match(response.body.warning, /No module named matplotlib/)
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('对照表 API：模型只调一次，第二次命中缓存；无效锚点被过滤', async () => {
  const { root, api, chatCalls } = await fixture()
  try {
    const first = await call(api.handler, 'POST', '/doraemon-paper-reader/api/compare/table', {
      jobIds: [JOB_A, JOB_B],
    })
    assert.equal(first.status, 200)
    assert.equal(first.body.cached, false)
    assert.equal(first.body.table.fields.find((field) => field.key === 'question').cells[0].grounded, true)
    assert.equal(chatCalls(), 1)

    const second = await call(api.handler, 'POST', '/doraemon-paper-reader/api/compare/table', {
      jobIds: [JOB_B, JOB_A],
    })
    assert.equal(second.status, 200)
    assert.equal(second.body.cached, true)
    assert.equal(chatCalls(), 1, '同一组论文不应重复调模型')
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('引用关系 API：返回支持度与证据块；主对话包带上引用处原文', async () => {
  const { root, api } = await fixture()
  try {
    const verdict = await call(api.handler, 'POST', '/doraemon-paper-reader/api/compare/citation', {
      citingJobId: JOB_A,
      citedJobId: JOB_B,
      blockId: 'a101',
      number: 12,
      title: 'Paper A',
    })
    assert.equal(verdict.status, 200)
    assert.equal(verdict.body.analysis.verdict, 'partially')
    assert.equal(verdict.body.analysis.evidence[0].blockId, 'b101')
    assert.match(verdict.body.citing.text, /Paper A measures/)

    const packet = await call(api.handler, 'POST', '/doraemon-paper-reader/api/compare/packet', {
      jobIds: [JOB_A, JOB_B],
      mode: 'citation',
      citing: { jobId: JOB_A, blockId: 'a101', number: 12, title: 'Paper A' },
      question: 'Does B support A?',
      annotations: [
        {
          jobId: JOB_A,
          question: '这个方法能复用吗？',
          context: { paper: { title: 'Paper A' } },
          segments: [{ page: 2, blockId: 'a101', quote: 'Paper A measures a sensor' }],
        },
      ],
    })
    assert.equal(packet.status, 200)
    assert.match(packet.body.message, /引用对照/)
    assert.match(packet.body.message, /Paper A measures/)
    assert.match(packet.body.message, /doraemon_read_papers/)
    assert.match(packet.body.message, new RegExp(JOB_B))
    assert.match(packet.body.message, /附带的跨论文批注（1 条）/)
    assert.match(packet.body.message, /这个方法能复用吗/)
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('对照 API：少于两篇/多于三篇/非法 id 都拒绝', async () => {
  const { root, api } = await fixture()
  try {
    const one = await call(api.handler, 'POST', '/doraemon-paper-reader/api/compare/digests', {
      jobIds: [JOB_A],
    })
    assert.equal(one.status, 400)
    const four = await call(api.handler, 'POST', '/doraemon-paper-reader/api/compare/digests', {
      jobIds: [JOB_A, JOB_B, 'job-cccccccc', 'job-dddddddd'],
    })
    assert.equal(four.status, 400)
    const bad = await call(api.handler, 'POST', '/doraemon-paper-reader/api/compare/digests', {
      jobIds: [JOB_A, '../../etc'],
    })
    assert.equal(bad.status, 400)
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('对照工作台 API：直接读取两篇档案回答，不经过主对话工具', async () => {
  const { root, api } = await fixture()
  try {
    const ask = await call(api.handler, 'POST', '/doraemon-paper-reader/api/compare/ask', {
      jobIds: [JOB_A, JOB_B],
      mode: 'survey',
      question: '这两篇的方法有什么不同？',
      annotations: [
        {
          jobId: JOB_A,
          question: '方法能复用吗？',
          context: { paper: { title: 'Paper A' } },
          segments: [{ page: 2, blockId: 'a101', quote: 'Paper A measures a sensor' }],
        },
      ],
    })
    assert.equal(ask.status, 200)
    assert.match(ask.body.answer, /工作台回答/)
    assert.equal(ask.body.mode, 'survey')
    assert.deepEqual(ask.body.jobIds, [JOB_A, JOB_B])
    const empty = await call(api.handler, 'POST', '/doraemon-paper-reader/api/compare/ask', {
      jobIds: [JOB_A, JOB_B],
      question: '   ',
    })
    assert.equal(empty.status, 400)
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('概念图 API：模型组织关系，原文节点保留锚点，归纳节点单独标记', async () => {
  const { root, api } = await fixture()
  try {
    const result = await call(api.handler, 'POST', '/doraemon-paper-reader/api/compare/concept', {
      jobIds: [JOB_A, JOB_B],
      question: '按方法和迁移风险画概念图',
    })
    assert.equal(result.status, 200)
    assert.equal(result.body.concept.kind, 'concept')
    assert.equal(result.body.concept.nodes.length, 2)
    assert.equal(result.body.concept.nodes[0].grounded, true)
    assert.equal(result.body.concept.nodes[0].blockId, 'a101')
    assert.equal(result.body.concept.nodes[1].origin, 'synthesis')
    assert.equal(result.body.concept.edges.length, 1)
    assert.equal(result.body.concept.stats.grounded, 1)
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('查词 API：只解释当前论文句子，进程内缓存不落用户词库', async () => {
  const { root, api } = await fixture()
  try {
    const body = {
      term: 'sensor',
      blockId: 'a101',
      before: 'Paper A measures a ',
      after: ' with a long enough paragraph',
    }
    const first = await call(
      api.handler,
      'POST',
      '/doraemon-paper-reader/api/jobs/' + JOB_A + '/term-lookup',
      body,
    )
    assert.equal(first.status, 200)
    assert.equal(first.body.lookup.term, 'sensor')
    assert.equal(first.body.lookup.contextMeaning, '本文中的传感器测量对象。')
    assert.equal(first.body.lookup.locator.blockId, 'a101')
    assert.equal(first.body.lookup.cached, false)
    assert.match(first.body.lookup.sentence, /Paper A measures a sensor/)

    const second = await call(
      api.handler,
      'POST',
      '/doraemon-paper-reader/api/jobs/' + JOB_A + '/term-lookup',
      body,
    )
    assert.equal(second.status, 200)
    assert.equal(second.body.lookup.cached, true)
    await assert.rejects(
      () => readFile(path.join(root, 'jobs', JOB_A, 'glossary.json'), 'utf8'),
      /ENOENT/,
      '查词不应顺手创建术语表文件',
    )
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('工程维护 API：统计缓存并只清理可重建数据，不碰论文正文', async () => {
  const { root, api } = await fixture()
  try {
    const cacheFiles = [
      path.join(root, 'comparisons', 'c1.json'),
      path.join(root, 'citation-analyses', 'c2.json'),
      path.join(root, 'citation-cards', 'c3.json'),
      path.join(root, 'jobs', JOB_A, 'vision-cache', 'preview.webp'),
      path.join(root, 'jobs', JOB_A, 'translations-cache.json'),
    ]
    for (const file of cacheFiles) {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, '{"cache":true}', 'utf8')
    }
    const before = await call(api.handler, 'GET', '/doraemon-paper-reader/api/maintenance')
    assert.equal(before.status, 200)
    assert.equal(before.body.jobs.count, 2)
    assert.ok(before.body.caches.totalBytes > 0)
    const cleaned = await call(
      api.handler,
      'POST',
      '/doraemon-paper-reader/api/maintenance/cleanup',
      { scopes: ['comparisons', 'citationAnalyses', 'citationCards', 'vision', 'translation'] },
    )
    assert.equal(cleaned.status, 200)
    assert.ok(cleaned.body.freedBytes > 0)
    for (const file of cacheFiles) await assert.rejects(() => readFile(file, 'utf8'))
    const paper = await readFile(path.join(root, 'jobs', JOB_A, 'mirrordoc.json'), 'utf8')
    assert.match(paper, /Paper A/)
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('后台任务取消：翻译在当前请求结束后停止并保留原文可读', async () => {
  let release = null
  let started = false
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { root, api } = await fixture({
    chatJsonImpl: async ({ system, user }) => {
      if (!String(system).includes('学术论文翻译引擎')) return {}
      started = true
      await gate
      const rows = JSON.parse(user)
      return Object.fromEntries(rows.map((row) => [row.id, '已取消的测试译文']))
    },
  })
  try {
    const begin = await call(
      api.handler,
      'POST',
      '/doraemon-paper-reader/api/jobs/' + JOB_A + '/translate',
    )
    assert.equal(begin.status, 202)
    for (let attempt = 0; attempt < 20 && !started; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(started, true)
    const cancelled = await call(
      api.handler,
      'POST',
      '/doraemon-paper-reader/api/jobs/' + JOB_A + '/cancel-task',
      { kind: 'translation' },
    )
    assert.equal(cancelled.status, 200)
    assert.equal(cancelled.body.state.cancelRequested, true)
    release()
    let status = null
    for (let attempt = 0; attempt < 40; attempt += 1) {
      status = await call(
        api.handler,
        'GET',
        '/doraemon-paper-reader/api/jobs/' + JOB_A + '/translate',
      )
      if (status.body.status !== 'running') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(status.body.status, 'cancelled')
    const paper = await readFile(path.join(root, 'jobs', JOB_A, 'mirrordoc.json'), 'utf8')
    assert.match(paper, /Paper A measures/)
  } finally {
    if (release) release()
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('本地归档 API：报告/表格/批注写入 compare-archives，列表可读', async () => {
  const { root, api } = await fixture()
  try {
    const saved = await call(api.handler, 'POST', '/doraemon-paper-reader/api/compare/archive', {
      jobIds: [JOB_A, JOB_B],
      mode: 'survey',
      titles: ['Paper A', 'Paper B'],
      report: '# 对照报告\n\n内容',
      table: { fields: [] },
      annotations: [],
      messages: [{ role: 'user', content: '对比一下' }],
    })
    assert.equal(saved.status, 201)
    assert.ok(saved.body.id)
    const listed = await call(api.handler, 'GET', '/doraemon-paper-reader/api/compare/archives')
    assert.equal(listed.status, 200)
    assert.equal(listed.body.archives.length, 1)
    assert.equal(listed.body.archives[0].id, saved.body.id)
    assert.deepEqual(listed.body.archives[0].titles, ['Paper A', 'Paper B'])
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

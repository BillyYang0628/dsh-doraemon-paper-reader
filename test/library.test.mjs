import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { createAnnotationBatchStore } from '../src/annotations.js'
import { createPaperApi } from '../src/papers.js'

const JOB_ID = 'abcdefgh'

/** 用最简 req/res 跑一次 handler，返回状态码与 JSON 体。 */
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

/** 原样返回字节的版本，用来验 assets 这类非 JSON 响应。 */
function callRaw(handler, method, url) {
  const req = Readable.from([])
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
        resolve({ status: this.status, buffer: Buffer.concat(chunks) })
      },
    }
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dpr-library-'))
  const jobDir = path.join(root, 'jobs', JOB_ID)
  await mkdir(path.join(jobDir, 'assets'), { recursive: true })
  await writeFile(
    path.join(jobDir, 'mirrordoc.json'),
    JSON.stringify({
      meta: { title: 'Test Paper', authors: 'A. Author', doi: '10.1000/test' },
      blocks: [],
    }),
    'utf8',
  )
  await writeFile(
    path.join(jobDir, 'paper-summary.json'),
    JSON.stringify({
      title: 'Test Paper',
      authors: 'A. Author',
      identifiers: { doi: '10.1000/test', arxiv: '' },
      generatedAt: '2026-10-19T10:00:00.000Z',
    }),
    'utf8',
  )
  await writeFile(path.join(jobDir, 'assets', 'figure-01.png'), Buffer.from([137, 80, 78, 71]))
  const annotations = createAnnotationBatchStore({ dataRoot: root })
  const api = createPaperApi({ packageRoot: process.cwd(), dataRoot: root, annotations })
  return { root, jobDir, api }
}

test('论文库：扫描磁盘作业，返回标题/标识符/批注数', async () => {
  const { root, api } = await fixture()
  try {
    const listed = await call(api.handler, 'GET', '/doraemon-paper-reader/api/library')
    assert.equal(listed.status, 200)
    assert.equal(listed.body.papers.length, 1)
    assert.equal(listed.body.papers[0].jobId, JOB_ID)
    assert.equal(listed.body.papers[0].title, 'Test Paper')
    assert.equal(listed.body.papers[0].doi, '10.1000/test')
    assert.equal(listed.body.papers[0].annotationCount, 0)
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('批注存档：PUT 后 GET 能读回，并按 jobId 隔离', async () => {
  const { root, api } = await fixture()
  try {
    const saved = await call(api.handler, 'PUT', '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/annotations', {
      items: [{ id: 'a1', jobId: JOB_ID, sent: true, segments: [], question: 'Q' }],
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.count, 1)

    const read = await call(api.handler, 'GET', '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/annotations')
    assert.equal(read.status, 200)
    assert.equal(read.body.items.length, 1)
    assert.equal(read.body.items[0].id, 'a1')
    assert.equal(read.body.items[0].sent, true)

    const listed = await call(api.handler, 'GET', '/doraemon-paper-reader/api/library')
    assert.equal(listed.body.papers[0].annotationCount, 1)
    assert.equal(listed.body.papers[0].sentCount, 1)
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('论文库：同一 DOI 的重复导入合并成一个主条目', async () => {
  const { root, api } = await fixture()
  const second = 'ijklmnop'
  const dir = path.join(root, 'jobs', second)
  try {
    await mkdir(path.join(dir, 'assets'), { recursive: true })
    await writeFile(
      path.join(dir, 'mirrordoc.json'),
      JSON.stringify({ meta: { title: 'Test Paper', authors: 'A. Author', doi: '10.1000/test' }, blocks: [] }),
      'utf8',
    )
    await writeFile(
      path.join(dir, 'paper-summary.json'),
      JSON.stringify({
        title: 'Test Paper',
        authors: 'A. Author',
        identifiers: { doi: '10.1000/test', arxiv: '' },
        generatedAt: '2026-10-19T11:00:00.000Z',
      }),
      'utf8',
    )
    await call(api.handler, 'PUT', '/doraemon-paper-reader/api/jobs/' + second + '/annotations', {
      items: [{ id: 'b1', jobId: second, sent: true, segments: [] }],
    })
    const listed = await call(api.handler, 'GET', '/doraemon-paper-reader/api/library')
    assert.equal(listed.body.papers.length, 1)
    assert.equal(listed.body.papers[0].copies, 2)
    assert.equal(listed.body.papers[0].annotationCount, 1)
    assert.equal(listed.body.papers[0].jobId, second)
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('论文库：无批注的重复导入优先打开最新生成副本', async () => {
  const { root, api } = await fixture()
  const newer = 'qrstuvwx'
  const dir = path.join(root, 'jobs', newer)
  try {
    await mkdir(path.join(dir, 'assets'), { recursive: true })
    await writeFile(
      path.join(dir, 'mirrordoc.json'),
      JSON.stringify({ meta: { title: 'Test Paper', authors: 'A. Author', doi: '10.1000/test' }, blocks: [] }),
      'utf8',
    )
    await writeFile(
      path.join(dir, 'paper-summary.json'),
      JSON.stringify({
        title: 'Test Paper',
        authors: 'A. Author',
        identifiers: { doi: '10.1000/test', arxiv: '' },
        generatedAt: '2026-10-20T11:00:00.000Z',
      }),
      'utf8',
    )
    const listed = await call(api.handler, 'GET', '/doraemon-paper-reader/api/library')
    assert.equal(listed.body.papers.length, 1)
    assert.equal(listed.body.papers[0].copies, 2)
    assert.equal(listed.body.papers[0].jobId, newer)
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('重启后：没有内存 job 也能从磁盘读 mirrordoc 与 assets', async () => {
  const { root, api } = await fixture()
  try {
    const doc = await call(api.handler, 'GET', '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/mirrordoc.json')
    assert.equal(doc.status, 200)
    assert.equal(doc.body.meta.title, 'Test Paper')

    const asset = await callRaw(api.handler, 'GET', '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/assets/figure-01.png')
    assert.equal(asset.status, 200)
    assert.equal(asset.buffer.length, 4)
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('重启后：状态路由从磁盘恢复已完成作业，不伪造运行态', async () => {
  const { root, api } = await fixture()
  try {
    const restored = await call(api.handler, 'GET', '/doraemon-paper-reader/api/jobs/' + JOB_ID)
    assert.equal(restored.status, 200, JSON.stringify(restored.body))
    assert.equal(restored.body.id, JOB_ID)
    assert.equal(restored.body.status, 'done')
    assert.equal(restored.body.stage, 'done')
    assert.equal(restored.body.metadata.title, 'Test Paper')
    assert.equal(restored.body.metadata.doi, '10.1000/test')
    assert.equal(restored.body.docUrl, '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/mirrordoc.json')
    assert.equal(restored.body.error, null)
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('版本核验：手动选择 VOR/录用稿/预印本并写入 MirrorDoc', async () => {
  const { root, api } = await fixture()
  try {
    const saved = await call(api.handler, 'PUT', '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/version', {
      kind: 'vor',
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.version.kind, 'vor')
    assert.equal(saved.body.version.verifiedBy, 'user')
    const doc = await call(api.handler, 'GET', '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/mirrordoc.json')
    assert.equal(doc.body.version.kind, 'vor')
    const invalid = await call(api.handler, 'PUT', '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/version', {
      kind: 'random',
    })
    assert.equal(invalid.status, 400)
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

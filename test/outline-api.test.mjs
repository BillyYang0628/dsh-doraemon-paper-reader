import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { createPaperApi, routeRequest } from '../src/papers.js'

const JOB_ID = 'outlinejob'

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

async function fixture(
  chatJsonImpl = async () => ({
    groups: [
      {
        label: '背景与方法',
        summary: '论文提出一种新方法。',
        items: [
          { blockId: 'b1', label: '研究背景', summary: '说明研究问题。' },
          { blockId: 'b3', label: '方法设计', summary: '描述处理流程。' },
        ],
      },
    ],
  }),
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dpr-outline-api-'))
  const jobDir = path.join(root, 'jobs', JOB_ID)
  await mkdir(jobDir, { recursive: true })
  await writeFile(
    path.join(jobDir, 'mirrordoc.json'),
    JSON.stringify({
      meta: {
        title: 'Outline API Paper',
        abstract: 'An abstract about a new method.',
        brief: {
          sections: [
            { heading: '1. Introduction', gist: 'Research background.' },
            { heading: '2. Method', gist: 'The proposed approach.' },
          ],
        },
      },
      blocks: [
        { id: 'b1', type: 'heading', text: '1. Introduction', page: 1 },
        { id: 'b2', type: 'paragraph', text: 'Background paragraph with enough words for context.', page: 1 },
        { id: 'b3', type: 'heading', text: '2. Method', page: 2 },
        { id: 'b4', type: 'paragraph', text: 'Method paragraph describes the proposed processing pipeline.', page: 2 },
        { id: 'b5', type: 'table', text: 'Table 1: result', page: 3 },
        { id: 'b6', type: 'heading', text: 'References', page: 4 },
      ],
    }),
    'utf8',
  )
  let chatCalls = 0
  const api = createPaperApi({
    packageRoot: process.cwd(),
    dataRoot: root,
    chatJsonImpl: async (...args) => {
      chatCalls += 1
      return chatJsonImpl(...args)
    },
  })
  return {
    root,
    api,
    jobDir,
    calls: () => chatCalls,
  }
}

test('语义目录路由与缓存：缺失、生成、复用、强制更新', async () => {
  const { root, api, jobDir, calls } = await fixture()
  try {
    const missing = await call(
      api.handler,
      'GET',
      '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/semantic-outline',
    )
    assert.equal(missing.status, 200)
    assert.equal(missing.body.status, 'missing')
    assert.equal(missing.body.outline.semantic, false)

    const generated = await call(
      api.handler,
      'POST',
      '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/semantic-outline',
      {},
    )
    assert.equal(generated.status, 200)
    assert.equal(generated.body.status, 'generated')
    assert.equal(generated.body.outline.semantic, true)
    assert.equal(generated.body.outline.groups[0].items[0].originalTitle, '1. Introduction')
    assert.equal(calls(), 1)

    const cached = await call(
      api.handler,
      'POST',
      '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/semantic-outline',
      {},
    )
    assert.equal(cached.body.status, 'cached')
    assert.equal(calls(), 1)
    assert.ok(await readFile(path.join(jobDir, 'semantic-outline.v1.json'), 'utf8'))

    const forced = await call(
      api.handler,
      'POST',
      '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/semantic-outline',
      { force: true },
    )
    assert.equal(forced.body.status, 'generated')
    assert.equal(calls(), 2)
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('语义目录路由形状', () => {
  assert.deepEqual(
    routeRequest('/doraemon-paper-reader/api/jobs/' + JOB_ID + '/semantic-outline'),
    { type: 'semantic-outline', jobId: JOB_ID },
  )
})

test('语义目录失败：原始 Not found 会转成可读中文回退提示', async () => {
  const { root, api } = await fixture(async () => {
    throw new Error('Not found')
  })
  try {
    const result = await call(
      api.handler,
      'POST',
      '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/semantic-outline',
      {},
    )
    assert.equal(result.status, 200)
    assert.equal(result.body.status, 'fallback')
    assert.match(result.body.warning, /服务暂未就绪/)
    assert.doesNotMatch(result.body.warning, /Not found/)
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import {
  BATCH_ID_RE,
  assertAnnotationPacket,
  buildAnnotationMessage,
  createAnnotationBatchStore,
  createReadAnnotationsTool,
  summarizeAnnotationPacket,
} from '../src/annotations.js'
import { createPaperApi, routeRequest } from '../src/papers.js'

function samplePacket() {
  return {
    type: 'doraemon-annotations',
    question: '这两段之间是什么关系？',
    annotations: [
      {
        index: 1,
        jobId: 'abcdefgh',
        question: '这段引言提出了什么问题？',
        context: {
          paper: { title: 'Vibration monitoring of stacked fruit in transit', doi: '10.1000/test', arxiv: '' },
          version: { kind: 'vor', label: '正式版', source: 'local', license: 'CC BY 4.0', sha256: 'abc' },
          brief: { abstract: '摘要', sections: [], figures: [], tables: [], equations: [], referenceCount: 2 },
        },
        segments: [
          {
            quote: 'track and monitor cargo conditions.',
            before: '',
            after: 'The authors intended to reduce...',
            page: 3,
            blockId: 'b0008',
            section: '2. Related Work',
            kind: 'text',
          },
        ],
      },
      {
        index: 2,
        jobId: 'abcdefgh',
        question: '',
        context: { paper: { title: 'Vibration monitoring of stacked fruit in transit' } },
        segments: [
          {
            quote: 'MRMS =',
            before: '',
            after: '',
            page: 7,
            blockId: 'b0042',
            section: '3. Method',
            kind: 'equation',
          },
        ],
      },
    ],
  }
}

test('批注摘要：只出现批注 1/2、页码和短批次号，不出现整包 JSON', () => {
  const message = buildAnnotationMessage(samplePacket(), 'batch_0123456789abcdef01234567')
  assert.match(message, /2 条批注/)
  assert.match(message, /批注 1/)
  assert.match(message, /批注 2/)
  assert.match(message, /p\.3/)
  assert.match(message, /p\.7/)
  assert.match(message, /doraemon_read_annotations/)
  assert.match(message, /batch_0123456789abcdef01234567/)
  assert.doesNotMatch(message, /"segments"/)
  assert.doesNotMatch(message, /"quote"/)
  assert.doesNotMatch(message, /track and monitor cargo conditions/)
  assert.doesNotMatch(message, /\*\*|`/)
  assert.ok(message.length < 900, '摘要不应该重新变成长文本')
})

test('跨论文批注：同一次发送里标明两篇论文，并要求先分开理解再回答', () => {
  const packet = samplePacket()
  packet.annotations[1].jobId = 'ijklmnop'
  packet.annotations[1].context = { paper: { title: 'A second paper on plague' } }
  const message = buildAnnotationMessage(packet, 'batch_0123456789abcdef01234567')
  assert.match(message, /跨 2 篇论文的 2 条批注/)
  assert.match(message, /Vibration monitoring of stacked fruit/)
  assert.match(message, /A second paper on plague/)
  assert.match(message, /先把论文分别理解|先按论文分别理解/)
  assert.match(message, /不要把一篇的结论安到另一篇/)
  const meta = summarizeAnnotationPacket(packet)
  assert.equal(meta.paper, '2 篇论文')
  assert.equal(meta.papers.length, 2)
  assert.match(meta.lines[1], /A second paper on plague/)
})

test('批注包校验：拒绝空批注、空片段与超量批注', () => {
  assert.throws(() => assertAnnotationPacket(null), /对象/)
  assert.throws(() => assertAnnotationPacket({ type: 'doraemon-annotations', annotations: [] }), /至少/)
  assert.throws(
    () =>
      assertAnnotationPacket({
        type: 'doraemon-annotations',
        annotations: [{ question: '', segments: [{ quote: ' ' }] }],
      }),
    /空的/,
  )
  const tooMany = Array.from({ length: 51 }, () => ({
    question: '',
    segments: [{ quote: 'x' }],
  }))
  assert.throws(
    () => assertAnnotationPacket({ type: 'doraemon-annotations', annotations: tooMany }),
    /最多/,
  )
})

test('批次仓库：保存后可读回完整包，批次号形状固定', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dpr-annotations-'))
  try {
    const store = createAnnotationBatchStore({ dataRoot: root })
    const saved = await store.save(samplePacket())
    assert.match(saved.batchId, BATCH_ID_RE)
    assert.equal(saved.count, 2)
    assert.match(saved.message, /批注 1/)
    const record = await store.read(saved.batchId)
    assert.equal(record.batchId, saved.batchId)
    assert.equal(record.packet.annotations.length, 2)
    assert.equal(record.packet.annotations[0].segments[0].blockId, 'b0008')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('批次仓库：超过 512 KB 的批注包拒绝落盘', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dpr-annotations-'))
  try {
    const store = createAnnotationBatchStore({ dataRoot: root })
    const packet = samplePacket()
    packet.annotations[0].segments[0].quote = 'x'.repeat(600 * 1024)
    await assert.rejects(() => store.save(packet), /512 KB/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('批次仓库：特殊块补上只读 assetPath，供模型按需 read_image', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dpr-annotations-'))
  try {
    const store = createAnnotationBatchStore({ dataRoot: root })
    const packet = samplePacket()
    packet.annotations[1].segments[0] = {
      ...packet.annotations[1].segments[0],
      kind: 'table',
      label: 'Table 1',
      asset: 'assets/table-01.png',
    }
    const saved = await store.save(packet)
    const record = await store.read(saved.batchId)
    assert.equal(
      record.packet.annotations[1].segments[0].assetPath,
      path.join(root, 'jobs', 'abcdefgh', 'assets', 'table-01.png'),
    )
    assert.equal(
      record.packet.annotations[1].segments[0].citationDeepLink,
      'dsh-resource://doraemon-paper/abcdefgh/b0042',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('读取工具：模型拿到完整包，卡片只拿摘要', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dpr-annotations-'))
  try {
    const store = createAnnotationBatchStore({ dataRoot: root })
    const saved = await store.save(samplePacket())
    const tool = createReadAnnotationsTool({ store })
    assert.equal(tool.name, 'doraemon_read_annotations')
    const value = await tool.execute({ batchId: saved.batchId })
    assert.equal(value.batchId, saved.batchId)
    assert.equal(value.annotations[0].segments[0].quote, 'track and monitor cargo conditions.')

    const rendered = tool.output.render({ batchId: saved.batchId }, value)
    assert.equal(rendered[0].type, 'text')
    assert.match(rendered[0].text, /"segments"/)
    assert.match(rendered[0].text, /track and monitor cargo conditions/)

    const meta = tool.output.presentationMeta({ batchId: saved.batchId }, value)
    assert.equal(meta.count, 2)
    assert.deepEqual(meta.lines.length, 2)
    assert.doesNotMatch(meta.lines.join('\n'), /"segments"/)
    const card = tool.presentResult({ batchId: saved.batchId }, { meta, content: [], isError: false })
    assert.match(card.title, /2 条批注/)
    assert.doesNotMatch(card.content[0].text, /"segments"/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('摘要函数：页码与段数简洁可读', () => {
  const summary = summarizeAnnotationPacket(samplePacket())
  assert.equal(summary.count, 2)
  assert.equal(summary.lines[0], '批注 1 · p.3 · 2. Related Work — 「这段引言提出了什么问题？」')
  assert.equal(summary.lines[1], '批注 2 · p.7 · 公式 — （只标记）')
})

test('摘要：图表/公式优先显示 Table 1 / Figure 1 / Equation 1 这类标签', () => {
  const packet = samplePacket()
  packet.annotations[1].segments[0].kind = 'table'
  packet.annotations[1].segments[0].label = 'Table 1'
  const summary = summarizeAnnotationPacket(packet)
  assert.match(summary.lines[1], /^批注 2 · p\.7 · Table 1 —/)
})

test('摘要上限：超过 12 条时只列前 12 条，其余指向批次', () => {
  const base = samplePacket()
  const packet = {
    ...base,
    annotations: Array.from({ length: 14 }, (_, index) => ({
      ...base.annotations[0],
      index: index + 1,
      question: '问题 ' + (index + 1),
    })),
  }
  const message = buildAnnotationMessage(packet, 'batch_0123456789abcdef01234567')
  assert.match(message, /另有 2 条批注/)
  assert.doesNotMatch(message, /批注 13/)
  const summary = summarizeAnnotationPacket(packet)
  assert.equal(summary.lines.length, 13)
  assert.match(summary.lines[12], /另有 2 条批注/)
})

test('API 路由：批注保存与读取', () => {
  assert.deepEqual(routeRequest('/doraemon-paper-reader/api/annotation-batches'), {
    type: 'annotation-save',
  })
  assert.deepEqual(
    routeRequest('/doraemon-paper-reader/api/annotation-batches/batch_0123456789abcdef01234567'),
    { type: 'annotation-read', batchId: 'batch_0123456789abcdef01234567' },
  )
  assert.equal(routeRequest('/doraemon-paper-reader/api/annotation-batches/../../secret'), null)
})

test('API handler：POST 保存返回摘要，GET 能读回完整包', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dpr-annotations-'))
  try {
    const annotations = createAnnotationBatchStore({ dataRoot: root })
    const api = createPaperApi({ packageRoot: process.cwd(), dataRoot: root, annotations })
    const post = Readable.from([Buffer.from(JSON.stringify(samplePacket()), 'utf8')])
    post.method = 'POST'
    post.url = '/doraemon-paper-reader/api/annotation-batches'
    post.headers = {}
    const posted = await call(api.handler, post)
    assert.equal(posted.status, 201)
    assert.match(posted.body.message, /批注 1/)
    assert.doesNotMatch(posted.body.message, /"segments"/)

    const get = Readable.from([])
    get.method = 'GET'
    get.url = '/doraemon-paper-reader/api/annotation-batches/' + posted.body.batchId
    get.headers = {}
    const read = await call(api.handler, get)
    assert.equal(read.status, 200)
    assert.equal(read.body.packet.annotations.length, 2)
    api.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/** 用最简 req/res 跑一次 handler，返回状态码与 JSON 体。 */
function call(handler, req) {
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
        try {
          resolve({ status: this.status, headers: this.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        } catch (cause) {
          reject(cause)
        }
      },
    }
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

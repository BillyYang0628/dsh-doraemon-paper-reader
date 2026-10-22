import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

import { createAnnotationBatchStore } from '../src/annotations.js'
import { createPaperApi } from '../src/papers.js'

const JOB_ID = 'abcdefgh'

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

async function fixture(chatJsonImpl, fetchImpl, visionJsonImpl) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dpr-citation-api-'))
  const jobDir = path.join(root, 'jobs', JOB_ID)
  await mkdir(jobDir, { recursive: true })
  await writeFile(
    path.join(jobDir, 'mirrordoc.json'),
    JSON.stringify({
      meta: { title: 'Citing Paper', authors: 'A. Author', doi: '10.1000/citing' },
      blocks: [
        { id: 'b0', type: 'paragraph', text: 'As shown before [1], this matters.', page: 2 },
        { id: 'b1', type: 'reference', text: '1. A cited paper. Journal, 2020.', page: 5 },
      ],
    }),
    'utf8',
  )
  await writeFile(
    path.join(jobDir, 'paper-summary.json'),
    JSON.stringify({
      title: 'Citing Paper',
      authors: 'A. Author',
      abstract: 'Citing paper abstract.',
      identifiers: { doi: '10.1000/citing', arxiv: '' },
      sections: [{ heading: 'Results', gist: 'A short gist.' }],
      generatedAt: '2026-10-20T10:00:00.000Z',
    }),
    'utf8',
  )
  const annotations = createAnnotationBatchStore({ dataRoot: root })
  const api = createPaperApi({
    packageRoot: process.cwd(),
    dataRoot: root,
    annotations,
    chatJsonImpl,
    fetchImpl,
    visionJsonImpl,
    pythonRuntime: {
      ensure: async () => ({ status: 'ready', executable: 'python' }),
      inspect: async () => ({ status: 'ready', executable: 'python' }),
      status: () => ({ status: 'ready', executable: 'python' }),
    },
  })
  return { root, api }
}

test('引用索引路由：正文 span 与参考文献编号对应', async () => {
  const { root, api } = await fixture(async () => ({}))
  try {
    const result = await call(api.handler, 'GET', '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/citations')
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(result.body.referenceCount, 1)
    assert.equal(result.body.byBlock.b0[0].numbers[0], 1)
    assert.equal(result.body.references[0].blockId, 'b1')
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('引用分析路由：概览/关系落盘并命中缓存', async () => {
  let calls = 0
  const { root, api } = await fixture(async () => {
    calls += 1
    return {
      overview: { question: 'Q', method: 'M', findings: 'F', limitations: 'L' },
      relation: {
        stance: 'supports',
        summary: 'The citing passage cites it as support.',
        points: [{ claim: 'C', citingEvidence: 'p.2', citedEvidence: 'p.5' }],
      },
      warnings: [],
    }
  })
  try {
    const payload = {
      jobId: JOB_ID,
      referenceText: '1. A cited paper. Journal, 2020.',
      number: 1,
      citing: {
        jobId: JOB_ID,
        blockId: 'b0',
        section: 'Introduction',
        quote: 'As shown before [1], this matters.',
      },
    }
    const first = await call(api.handler, 'POST', '/doraemon-paper-reader/api/citations/analyze', payload)
    assert.equal(first.status, 200)
    assert.equal(first.body.overview.question, 'Q')
    assert.equal(first.body.relation.stance, 'supports')
    assert.equal(first.body.basis, 'full-text')
    assert.equal(first.body.cached, false)

    const second = await call(api.handler, 'POST', '/doraemon-paper-reader/api/citations/analyze', payload)
    assert.equal(second.status, 200)
    assert.equal(second.body.cached, true)
    assert.equal(calls, 1)

    const cachedCard = await call(
      api.handler,
      'POST',
      '/doraemon-paper-reader/api/citations/resolve',
      {
        referenceText: payload.referenceText,
        number: payload.number,
        citing: payload.citing,
      },
    )
    assert.equal(cachedCard.status, 200)
    assert.equal(cachedCard.body.kind, 'cached')
    assert.equal(cachedCard.body.analysis.overview.question, 'Q')
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('引用解析路由：无合法全文时诚实降级为 metadata-only', async () => {
  const fetchImpl = async (url) => {
    const text = String(url)
    if (text.includes('api.openalex.org')) {
      const payload = {
        title: 'A cited paper',
        doi: 'https://doi.org/10.1000/cited',
        publication_year: 2020,
        authorships: [{ author: { display_name: 'A. Author' } }],
        primary_location: { landing_page_url: 'https://publisher.example/cited', is_oa: false },
        open_access: { is_oa: false },
        cited_by_count: 3,
      }
      return {
        ok: true,
        text: async () => JSON.stringify(payload),
      }
    }
    return {
      ok: true,
      text: async () => '<html><head></head><body>publisher</body></html>',
      headers: { get: () => '' },
    }
  }
  const { root, api } = await fixture(async () => ({}), fetchImpl)
  try {
    const result = await call(
      api.handler,
      'POST',
      '/doraemon-paper-reader/api/citations/resolve',
      {
        referenceText: '1. A. Author. A cited paper. 2020. doi:10.1000/cited',
        number: 1,
        citing: { quote: '[1]' },
      },
    )
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(result.body.kind, 'metadata-only')
    assert.equal(result.body.metadata.doi, '10.1000/cited')
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('引用解析：非标识符路径保留作者/年份/venue，并返回可解释主候选', async () => {
  const fetchImpl = async (url) => {
    const text = String(url)
    if (text.startsWith('https://api.openalex.org/works?')) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            results: [
              {
                title: 'Deep Learning for Image Data',
                doi: 'https://doi.org/10.1000/noise',
                publication_year: 2020,
                authorships: [{ author: { display_name: 'Noise Author' } }],
                primary_location: { source: { display_name: 'Image Journal' } },
              },
            ],
          }),
      }
    }
    if (text.startsWith('https://api.crossref.org/works?')) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            message: {
              items: [
                {
                  DOI: '10.1000/correct',
                  title: ['Deep Learning for Tabular Data: A Survey'],
                  author: [{ given: 'Alice', family: 'Smith' }],
                  published: { 'date-parts': [[2023]] },
                  'container-title': ['ACM Computing Surveys'],
                  abstract: 'A survey of tabular learning.',
                  type: 'journal-article',
                },
              ],
            },
          }),
      }
    }
    return {
      ok: true,
      text: async () =>
        '<feed xmlns="http://www.w3.org/2005/Atom"></feed>',
    }
  }
  const { root, api } = await fixture(async () => ({}), fetchImpl)
  try {
    const result = await call(
      api.handler,
      'POST',
      '/doraemon-paper-reader/api/citations/resolve',
      {
        referenceText:
          '1. Alice Smith (2023) Deep Learning for Tabular Data: A Survey. ACM Computing Surveys 55, 1-30.',
        number: 1,
        citing: { quote: 'Tabular retrieval has advanced [1].' },
      },
    )
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(result.body.kind, 'candidates')
    assert.equal(result.body.candidates[0].doi, '10.1000/correct')
    assert.equal(result.body.candidates[0].isPrimary, true)
    assert.equal(result.body.candidates[0].confidence, 'high')
    assert.match(result.body.candidates[0].reasons.join('；'), /标题|作者|年份|刊物/)
    assert.ok(result.body.retrieval.routes.length >= 3)
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('引用解析：缺失参考文献原文返回业务 invalid，而不是裸 HTTP 400', async () => {
  const { root, api } = await fixture(async () => ({}))
  try {
    const resolve = await call(
      api.handler,
      'POST',
      '/doraemon-paper-reader/api/citations/resolve',
      { referenceText: '', number: 1, citing: { quote: '[1]' } },
    )
    assert.equal(resolve.status, 200)
    assert.equal(resolve.body.kind, 'invalid')
    assert.match(resolve.body.message, /参考文献/)

    const analyze = await call(
      api.handler,
      'POST',
      '/doraemon-paper-reader/api/citations/analyze',
      { referenceText: '', number: 1, citing: { quote: '[1]' } },
    )
    assert.equal(analyze.status, 200)
    assert.equal(analyze.body.kind, 'invalid')

    const malformed = await call(
      api.handler,
      'POST',
      '/doraemon-paper-reader/api/citations/resolve',
      [],
    )
    assert.equal(malformed.status, 200)
    assert.equal(malformed.body.kind, 'invalid')
    assert.equal(malformed.body.reason, 'invalid-payload')
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('引用预览提升：从 citation-previews 移入论文库，并保留可读产物', async () => {
  const { root, api } = await fixture(async () => ({}))
  const previewId = 'preview01'
  const previewDir = path.join(root, 'citation-previews', previewId)
  await mkdir(previewDir, { recursive: true })
  await writeFile(
    path.join(previewDir, 'mirrordoc.json'),
    JSON.stringify({ meta: { title: 'Preview Paper' }, blocks: [] }),
    'utf8',
  )
  api.jobs.set(previewId, {
    id: previewId,
    dir: previewDir,
    preview: true,
    status: 'done',
    stage: 'done',
    message: '预览完成',
    startedAt: '2026-10-20T10:00:00.000Z',
    metadata: { title: 'Preview Paper' },
  })
  try {
    const result = await call(api.handler, 'POST', '/doraemon-paper-reader/api/citations/promote', {
      jobId: previewId,
    })
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(result.body.promoted, true)
    assert.notEqual(result.body.jobId, previewId)
    const promoted = api.jobs.get(result.body.jobId)
    assert.equal(promoted.preview, false)
    assert.ok(promoted.dir.includes(path.join('jobs', result.body.jobId)))
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('翻译 API：分块翻译、落盘、状态可轮询', async () => {
  const { root, api } = await fixture(async ({ user }) => {
    const tasks = JSON.parse(user)
    return Object.fromEntries(tasks.map((task) => [task.id, '译：' + task.text]))
  })
  try {
    const started = await call(api.handler, 'POST', '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/translate')
    assert.equal(started.status, 202)
    let status = started.body
    for (let attempt = 0; attempt < 50 && status.status === 'running'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      const polled = await call(api.handler, 'GET', '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/translate')
      assert.equal(polled.status, 200)
      status = polled.body
    }
    assert.equal(status.status, 'done')
    assert.equal(status.coverage.failed, 0)
    const saved = await call(api.handler, 'GET', '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/translations')
    assert.equal(saved.status, 200)
    assert.match(saved.body.blocks.b0.text, /译：/)
    assert.ok(saved.body.blocks.b0.segments.length > 0)
    assert.equal(saved.body.meta.title, '译：Citing Paper')
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('术语表 API：自动候选、保存覆盖并返回哈希', async () => {
  const { root, api } = await fixture(async () => ({}))
  try {
    const initial = await call(api.handler, 'GET', '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/glossary')
    assert.equal(initial.status, 200)
    assert.ok(Array.isArray(initial.body.entries))
    const saved = await call(api.handler, 'PUT', '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/glossary', {
      entries: [{ source: 'Citing Paper', target: '被引论文', locked: false }],
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.entries[0].target, '被引论文')
    assert.ok(saved.body.hash)
    const reread = await call(api.handler, 'GET', '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/glossary')
    assert.equal(reread.body.entries[0].target, '被引论文')
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('视觉资产 API：公式 LaTeX 与表格译文落盘，并校验表格数字', async () => {
  let visionCalls = 0
  const { root, api } = await fixture(
    async () => ({}),
    undefined,
    async ({ user }) => {
      visionCalls += 1
      if (String(user).includes('公式')) {
        return { latex: 'M(t)=\\sqrt{x(t)^2+y(t)^2}', confidence: 0.93, warnings: [] }
      }
      return {
        rows: [
          { header: true, cells: ['采样频率 [Hz]', '电流 [µA]'] },
          { cells: ['400', '16.869'] },
        ],
        warnings: [],
      }
    },
  )
  const jobDir = path.join(root, 'jobs', JOB_ID)
  try {
    await mkdir(path.join(jobDir, 'assets'), { recursive: true })
    await writeFile(path.join(jobDir, 'assets', 'equation-01.png'), Buffer.from([137, 80, 78, 71]))
    await writeFile(path.join(jobDir, 'assets', 'table-01.png'), Buffer.from([137, 80, 78, 71]))
    await writeFile(
      path.join(jobDir, 'mirrordoc.json'),
      JSON.stringify({
        meta: { title: 'Visual Paper' },
        blocks: [
          { id: 'e1', type: 'equation', label: 'Equation 1', page: 2, asset: 'assets/equation-01.png', text: 'x=1' },
          {
            id: 't1',
            type: 'table',
            label: 'Table 1',
            page: 3,
            asset: 'assets/table-01.png',
            tableText: 'Sampling Frequency [Hz] 400 16.869',
            text: 'Table 1.',
          },
        ],
      }),
      'utf8',
    )

    const formulaStarted = await call(api.handler, 'POST', '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/formulas')
    assert.equal(formulaStarted.status, 202)
    let formula = formulaStarted.body
    for (let attempt = 0; attempt < 30 && formula.status === 'running'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      formula = (await call(api.handler, 'GET', '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/formulas')).body
    }
    assert.equal(formula.status, 'done')
    assert.equal(formula.blocks.e1.valid, true)
    assert.match(formula.blocks.e1.latex, /sqrt/)
    const badFormula = await call(
      api.handler,
      'PUT',
      '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/formulas/e1',
      { latex: 'x=\\frac{1}{' },
    )
    assert.equal(badFormula.status, 400)
    const manualFormula = await call(
      api.handler,
      'PUT',
      '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/formulas/e1',
      { latex: 'M(t)=x(t)' },
    )
    assert.equal(manualFormula.status, 200)
    assert.equal(manualFormula.body.block.manual, true)

    const tableStarted = await call(api.handler, 'POST', '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/tables')
    assert.equal(tableStarted.status, 202)
    let table = tableStarted.body
    for (let attempt = 0; attempt < 30 && table.status === 'running'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      table = (await call(api.handler, 'GET', '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/tables')).body
    }
    assert.equal(table.status, 'done')
    assert.equal(table.blocks.t1.valid, true)
    assert.equal(table.blocks.t1.rows[1].cells[1], '16.869')
    assert.equal(visionCalls, 2)
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('整篇语义复核：回译 + 审校 + 合法修订写回译文', async () => {
  const { root, api } = await fixture(async ({ user }) => {
    const text = String(user)
    if (text.includes('没有给出可用修订')) {
      return { 'title:0': '' }
    }
    if (!text.includes('严格审校器')) {
      return { 'b0:0': 'The value is 42%.', 'title:0': 'A Paper' }
    }
    return {
      issues: [
        {
          taskId: 'b0:0',
          severity: 'error',
          category: 'number',
          detail: '数字和引用缺失',
          revisedTarget: '该值为 42% [1]。',
        },
        {
          taskId: 'title:0',
          severity: 'warning',
          category: 'term',
          detail: '标题需进一步确认',
          revisedTarget: '',
        },
      ],
      warnings: [],
    }
  })
  const jobDir = path.join(root, 'jobs', JOB_ID)
  try {
    await writeFile(
      path.join(jobDir, 'translations.zh.json'),
      JSON.stringify({
        version: 1,
        targetLang: 'zh-CN',
        model: 'test',
        promptVersion: 4,
        glossaryHash: '',
        meta: {
          title: '一篇论文',
          titleSegments: [{ taskId: 'title:0', source: 'A Paper', target: '一篇论文' }],
          abstractSegments: [],
        },
        blocks: {
          b0: {
            type: 'paragraph',
            source: 'The value [1] is 42%.',
            text: '数值为四十。',
            segments: [
              { taskId: 'b0:0', source: 'The value [1] is 42%.', target: '数值为四十。', targetSpans: [] },
            ],
          },
        },
        coverage: { segments: 2 },
      }),
      'utf8',
    )
    const started = await call(api.handler, 'POST', '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/review')
    assert.equal(started.status, 202)
    let status = started.body
    for (let attempt = 0; attempt < 50 && status.status === 'running'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      status = (await call(api.handler, 'GET', '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/review')).body
    }
    assert.equal(status.status, 'warn')
    assert.equal(status.review.applied, 1)
    assert.equal(status.review.issueCount, 2)
    assert.equal(status.review.pending, 1)
    assert.equal(status.review.accepted, 1)
    assert.equal(status.review.issues.find((issue) => issue.taskId === 'b0:0').automatic, true)
    const decided = await call(
      api.handler,
      'POST',
      '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/review/decisions',
      { taskId: 'title:0', action: 'accept' },
    )
    assert.equal(decided.status, 200, JSON.stringify(decided.body))
    assert.equal(decided.body.review.applied, 1)
    assert.equal(decided.body.issue.decision, 'accepted')
    const afterDecision = await call(
      api.handler,
      'GET',
      '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/review',
    )
    assert.equal(afterDecision.body.applied, 1)
    assert.equal(afterDecision.body.pending, 0)
    const saved = await call(api.handler, 'GET', '/doraemon-paper-reader/api/jobs/' + JOB_ID + '/translations')
    assert.equal(saved.body.blocks.b0.segments[0].target, '该值为 42% [1]。')
    assert.equal(saved.body.blocks.b0.segments[0].targetSpans[0].numbers[0], 1)
  } finally {
    api.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

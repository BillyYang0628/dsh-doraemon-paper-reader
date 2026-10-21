// L0：多篇对照协议。
//
// 两种模式的差别在这里被钉死：
//   survey  = 七字段横向对照，每个单元格必须有 blockId；
//   citation = 主张—证据关系，没有有效证据就降级为「证据不足」。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  COMPARE_FIELDS,
  buildCompareChatPrompt,
  buildConceptPrompt,
  buildVersionDiff,
  normalizeChartSpec,
  normalizeConceptSpec,
  buildCitationPrompt,
  buildCompactTableText,
  buildCompareMessage,
  buildSurveyPrompt,
  compareKey,
  createReadPapersTool,
  normalizeCitationVerdict,
  normalizeComparisonTable,
} from '../src/compare.js'
import { buildPaperDigest } from '../src/digest.js'

function makeDigest(jobId, title, blocks) {
  const doc = {
    meta: {
      title,
      authors: 'A. Author',
      abstract: title + ' abstract text, long enough to be useful in a comparison.',
      brief: { sections: blocks.map((block) => ({ heading: block.title, page: 1, gist: block.gist })) },
    },
    blocks: blocks.flatMap((block, index) => [
      { id: block.headingId, type: 'heading', text: block.title, section: block.title, page: 1 },
      {
        id: block.textId,
        type: 'paragraph',
        text: block.text,
        section: block.title,
        page: index + 2,
      },
    ]),
  }
  return buildPaperDigest({ jobId, doc })
}

const digestA = makeDigest('job-aaaaaaaa', 'Paper A', [
  {
    title: 'Introduction',
    headingId: 'a100',
    textId: 'a101',
    gist: 'A studies sensors.',
    text: 'Paper A studies low power sensors in a supply chain setting with a long enough paragraph for the digest.',
  },
  {
    title: 'Results',
    headingId: 'a200',
    textId: 'a201',
    gist: 'A reports an error of 0.42.',
    text: 'Paper A reports a root mean square error of 0.42 units across the full measurement range in the field trial.',
  },
])

const digestB = makeDigest('job-bbbbbbbb', 'Paper B', [
  {
    title: 'Introduction',
    headingId: 'b100',
    textId: 'b101',
    gist: 'B studies vibration.',
    text: 'Paper B studies vibration sensors for industrial machines with a long enough paragraph for the digest.',
  },
  {
    title: 'Results',
    headingId: 'b200',
    textId: 'b201',
    gist: 'B reports a different range.',
    text: 'Paper B reports a measurement range from 10 to 1000 hertz and a different calibration procedure in the laboratory.',
  },
])

test('字段：七项固定顺序，覆盖问题/对象/方法/指标/结果/局限/关系', () => {
  assert.deepEqual(
    COMPARE_FIELDS.map((field) => field.key),
    ['question', 'object', 'method', 'metric', 'result', 'limitation', 'relation'],
  )
})

test('综述表：有效 blockId 才算已定位；无效锚点保留文字但标未定位；空值记未找到', () => {
  const table = normalizeComparisonTable(
    {
      papers: [
        {
          jobId: digestA.jobId,
          fields: {
            question: { text: 'A question', blockIds: ['a101', 'not-a-block'] },
            method: { text: 'A method', blockIds: [] },
            result: { text: '未找到', blockIds: [] },
          },
        },
        {
          jobId: digestB.jobId,
          fields: {
            question: { text: 'B question', blockIds: ['b101'] },
            method: 'A plain string cell',
          },
        },
      ],
    },
    [digestA, digestB],
  )

  const question = table.fields.find((field) => field.key === 'question')
  assert.equal(question.cells[0].grounded, true)
  assert.deepEqual(question.cells[0].blockIds, ['a101'])
  assert.equal(question.cells[1].grounded, true)

  const method = table.fields.find((field) => field.key === 'method')
  assert.equal(method.cells[0].grounded, false)
  assert.equal(method.cells[0].text, 'A method')
  assert.equal(method.cells[1].grounded, false, '纯字符串没有 blockId，不能算已定位')

  const result = table.fields.find((field) => field.key === 'result')
  assert.equal(result.cells[0].text, '未找到')
  assert.equal(result.cells[0].missing, true)
  assert.equal(table.stats.ungrounded, 2)
  assert.equal(table.stats.missing, 10)
  assert.ok(table.warnings.length >= 1)
})

test('引用结论：有效证据才保留 supports；没有证据一律降级为证据不足', () => {
  const supported = normalizeCitationVerdict(
    {
      verdict: 'supports',
      claim: 'A says B measured the same range.',
      citedContribution: 'B reports 10–1000 Hz.',
      evidence: [{ blockId: 'b201', quote: '10 to 1000 hertz' }],
    },
    { digests: [digestA, digestB], citingJobId: digestA.jobId },
  )
  assert.equal(supported.verdict, 'supports')
  assert.equal(supported.evidence[0].jobId, digestB.jobId)
  assert.equal(supported.grounded, true)

  const noEvidence = normalizeCitationVerdict(
    { verdict: '支持', claim: 'A claim', evidence: [{ blockId: 'not-real' }] },
    { digests: [digestA, digestB], citingJobId: digestA.jobId },
  )
  assert.equal(noEvidence.verdict, 'insufficient')
  assert.equal(noEvidence.grounded, false)
  assert.match(noEvidence.warnings[0], /证据不足/)
})

test('提示词：综述带七字段与两篇档案；引用带引用处原文与被引论文', () => {
  const survey = buildSurveyPrompt({ digests: [digestA, digestB] })
  assert.match(survey.system, /设定不同/)
  assert.match(survey.user, /Paper A/)
  assert.match(survey.user, /Paper B/)
  assert.match(survey.user, /question/)
  assert.match(survey.user, /blockIds/)

  const citation = buildCitationPrompt({
    digests: [digestA, digestB],
    citing: { jobId: digestA.jobId, blockId: 'a101', page: 2, section: 'Introduction', text: 'B measured the same range.' },
  })
  assert.match(citation.system, /insufficient/)
  assert.match(citation.system, /A 只用于确定/)
  assert.match(citation.system, /evidence 只能来自 B/)
  assert.match(citation.user, /B measured the same range/)
  assert.match(citation.user, /a101/)
  assert.match(citation.user, /b201/)
  assert.match(citation.user, /【引用方 A】/)
  assert.match(citation.user, /【被引论文 B】/)
})

test('缓存键：论文顺序无关，引用位置与模式会换键', () => {
  const one = compareKey({ jobIds: [digestA.jobId, digestB.jobId], mode: 'survey' })
  const two = compareKey({ jobIds: [digestB.jobId, digestA.jobId], mode: 'survey' })
  assert.equal(one, two)
  assert.notEqual(one, compareKey({ jobIds: [digestA.jobId, digestB.jobId], mode: 'citation' }))
  assert.notEqual(
    one,
    compareKey({ jobIds: [digestA.jobId, digestB.jobId], mode: 'citation', citing: { jobId: digestA.jobId, blockId: 'a101' } }),
  )
})

test('主对话消息：综述要求对照表，引用要求主张—证据链，并带上 jobIds', () => {
  const survey = buildCompareMessage({ mode: 'survey', digests: [digestA, digestB], question: 'Can they be compared?' })
  assert.match(survey, /多篇对照/)
  assert.match(survey, /doraemon_read_papers/)
  assert.match(survey, new RegExp(digestA.jobId))
  assert.match(survey, /研究问题/)
  assert.match(survey, /设定不同/)

  const citation = buildCompareMessage({
    mode: 'citation',
    digests: [digestA, digestB],
    citing: { jobId: digestA.jobId, blockId: 'a101', number: 12, title: 'Paper A', text: 'B measured the same range.' },
  })
  assert.match(citation, /引用对照/)
  assert.match(citation, /\[12\]/)
  assert.match(citation, /支持度/)
  assert.match(citation, /逻辑链|缺哪一环/)

  const withNotes = buildCompareMessage({
    mode: 'survey',
    digests: [digestA, digestB],
    annotations: [
      {
        jobId: digestA.jobId,
        question: '这段的方法能复用吗？',
        context: { paper: { title: 'Paper A' } },
        segments: [{ page: 3, blockId: 'a101', quote: 'Paper A studies low power sensors.' }],
      },
      {
        jobId: digestB.jobId,
        question: '',
        context: { paper: { title: 'Paper B' } },
        segments: [{ page: 4, blockId: 'b201', quote: 'Paper B reports a range.' }],
      },
    ],
  })
  assert.match(withNotes, /附带的跨论文批注（2 条）/)
  assert.match(withNotes, /《Paper A》/)
  assert.match(withNotes, /《Paper B》/)
  assert.match(withNotes, /a101/)
  assert.match(withNotes, /先按论文归属理解/)
})

test('对照工作台提示词：带档案、批注、历史与当前问题', () => {
  const prompt = buildCompareChatPrompt({
    mode: 'survey',
    digests: [digestA, digestB],
    annotations: [
      {
        jobId: digestA.jobId,
        question: '方法能复用吗？',
        context: { paper: { title: 'Paper A' } },
        segments: [{ page: 2, blockId: 'a101', quote: 'Paper A studies low power sensors.' }],
      },
    ],
    history: [
      { role: 'user', content: '先看方法' },
      { role: 'assistant', content: '好的，先看方法。' },
    ],
    question: '这两篇的方法有什么不同？',
  })
  assert.match(prompt.system, /blockId/)
  assert.match(prompt.user, /Paper A/)
  assert.match(prompt.user, /Paper B/)
  assert.match(prompt.user, /附带的跨论文批注|随本次提问附带/)
  assert.match(prompt.user, /先看方法/)
  assert.match(prompt.user, /当前问题：这两篇的方法有什么不同/)
})

test('紧凑表：未找到不标「未定位」，无锚点才标', () => {
  const table = normalizeComparisonTable(
    {
      papers: [
        { jobId: digestA.jobId, fields: { question: { text: 'Q', blockIds: ['a101'] }, method: { text: 'M', blockIds: [] } } },
        { jobId: digestB.jobId, fields: { question: { text: '未找到', blockIds: [] } } },
      ],
    },
    [digestA, digestB],
  )
  const text = buildCompactTableText(table)
  assert.match(text, /P1 Q/)
  assert.doesNotMatch(text, /P2 未找到（未定位）/)
  assert.match(text, /P1 M（未定位）/)
})

test('工具：doraemon_read_papers 只收 1–3 个 jobId，返回档案', async () => {
  let seen = null
  const tool = createReadPapersTool({
    readDigests: async (jobIds) => {
      seen = jobIds
      return [digestA, digestB]
    },
  })
  assert.equal(tool.name, 'doraemon_read_papers')
  assert.equal(tool.parameters.properties.jobIds.maxItems, 3)
  const result = await tool.execute({ jobIds: [digestA.jobId, digestB.jobId] })
  assert.deepEqual(seen, [digestA.jobId, digestB.jobId])
  assert.equal(result.digests.length, 2)
})

test('版本差异：段落级 LCS 分出新增与删除', () => {
  const left = {
    version: { kind: 'preprint', label: '预印本' },
    meta: { title: 'Paper' },
    blocks: [
      { id: 'l1', type: 'paragraph', text: 'same one', page: 1, section: 'Intro' },
      { id: 'l2', type: 'paragraph', text: 'old only', page: 2, section: 'Methods' },
      { id: 'l3', type: 'paragraph', text: 'same two', page: 3, section: 'Results' },
    ],
  }
  const right = {
    version: { kind: 'vor', label: '正式版 VOR' },
    meta: { title: 'Paper' },
    blocks: [
      { id: 'r1', type: 'paragraph', text: 'same one', page: 1, section: 'Intro' },
      { id: 'r2', type: 'paragraph', text: 'new only', page: 2, section: 'Methods' },
      { id: 'r3', type: 'paragraph', text: 'same two', page: 3, section: 'Results' },
    ],
  }
  const diff = buildVersionDiff(left, right)
  assert.equal(diff.unchanged, 2)
  assert.deepEqual(diff.added.map((item) => item.blockId), ['r2'])
  assert.deepEqual(diff.removed.map((item) => item.blockId), ['l2'])
  assert.equal(diff.left.version.kind, 'preprint')
  assert.equal(diff.right.version.label, '正式版 VOR')
})

test('模型图表：只保留能在表格/档案里核对的数字', () => {
  const table = {
    fields: [
      {
        key: 'result',
        cells: [
          { jobId: digestA.jobId, text: 'pIP1202 全长 182,913 bp', blockIds: ['a101'], grounded: true },
          { jobId: digestB.jobId, text: '误差 0.42 units', blockIds: ['b101'], grounded: true },
        ],
      },
    ],
  }
  const chart = normalizeChartSpec(
    {
      title: '规模对比',
      type: 'bar',
      unit: 'bp',
      series: [
        {
          label: 'P1',
          points: [
            {
              label: 'pIP1202',
              value: 182913,
              source: { jobId: digestA.jobId, blockId: 'a101', quote: '182,913 bp' },
            },
            {
              label: '编造',
              value: 999,
              source: { jobId: digestA.jobId, blockId: 'a101', quote: '999 bp' },
            },
            {
              label: '无锚点',
              value: 0.42,
              source: { jobId: digestB.jobId, blockId: 'bad', quote: '0.42 units' },
            },
          ],
        },
      ],
    },
    { digests: [digestA, digestB], table },
  )
  assert.equal(chart.series.length, 1)
  assert.equal(chart.series[0].points.length, 1)
  assert.equal(chart.series[0].points[0].value, 182913)
  assert.equal(chart.stats.dropped, 2)

  const line = normalizeChartSpec(
    {
      title: '趋势',
      type: 'line',
      series: [
        {
          label: 'P1',
          points: [
            {
              label: 'pIP1202',
              value: 182913,
              source: { jobId: digestA.jobId, blockId: 'a101', quote: '182,913 bp' },
            },
          ],
        },
      ],
    },
    { digests: [digestA, digestB], table },
  )
  assert.equal(line.type, 'line')
  assert.equal(line.series[0].points.length, 1)
})

test('概念图：有原文锚点的事实保留来源，无来源关系明确标成模型归纳', () => {
  const prompt = buildConceptPrompt({
    digests: [digestA, digestB],
    question: '画两篇论文的方法和证据关系',
  })
  assert.match(prompt.system, /source\.blockId/)
  assert.match(prompt.system, /模型归纳/)
  assert.match(prompt.user, /Paper A/)
  assert.match(prompt.user, /画两篇论文的方法和证据关系/)

  const concept = normalizeConceptSpec(
    {
      title: '方法关系',
      summary: '把原文证据和跨论文归纳分开。',
      nodes: [
        {
          id: 'n1',
          label: '低功耗传感器',
          detail: 'A 研究供应链传感器。',
          kind: 'method',
          source: {
            jobId: digestA.jobId,
            blockId: 'a101',
            quote: 'low power sensors in a supply chain setting',
          },
        },
        {
          id: 'n2',
          label: '跨论文验证缺口',
          detail: '两篇使用不同实验设定，不能直接合并结论。',
          kind: 'synthesis',
        },
        {
          id: 'n3',
          label: '伪锚点',
          detail: '看起来有出处。',
          source: {
            jobId: digestA.jobId,
            blockId: 'a101',
            quote: '这段原文不存在',
          },
        },
        {
          id: 'n4',
          label: '错误数字 999',
          detail: '没有原文锚点。',
        },
      ],
      edges: [
        { from: 'n1', to: 'n2', label: '引出验证缺口' },
        { from: 'n1', to: 'missing', label: '无效边' },
      ],
    },
    { digests: [digestA, digestB] },
  )

  assert.equal(concept.nodes.length, 3)
  assert.equal(concept.nodes[0].grounded, true)
  assert.equal(concept.nodes[0].blockId, 'a101')
  assert.equal(concept.nodes[1].origin, 'synthesis')
  assert.equal(concept.nodes[2].grounded, false)
  assert.equal(concept.edges.length, 1)
  assert.equal(concept.stats.grounded, 1)
  assert.equal(concept.stats.dropped, 1)
  assert.match(concept.warnings.join('；'), /无效锚点|无法在原文中核对/)
})

// 宿主半区：多篇对照的协议层（纯逻辑 + 一个模型读取工具）。
//
// 两种对照不是同一件事：
//   - 综述模式（survey）：横向比较两三篇。重点是把「共同结论 / 设定不同 / 真正冲突 / 证据差异」
//     分开，最后落到一张按字段对齐的对照表；
//   - 引用模式（citation）：A 在 [n] 处援引 B。重点是主张—证据关系：A 说了什么、B 实际做了什么、
//     B 是否支撑 A、逻辑链缺哪一环。它不追求覆盖全部字段，只追一条引用链是否成立。
//
// 本模块只产出提示词、校验模型输出、生成主对话消息；不读文件、不调模型。

import { DIGEST_VERSION, digestToText } from './digest.js'
import { buildQaSystemContract } from './qa-contract.js'

/** 对照提示词版本；改了规则就递增，缓存随之失效。 */
export const COMPARE_PROMPT_VERSION = 6

/** B9 三条核心旅程；数量限制由产品流程和协议层共同执行。 */
export const SURVEY_MODES = Object.freeze({
  method: Object.freeze({
    label: '2 篇方法对照',
    minPapers: 2,
    maxPapers: 2,
    goal: '判断两篇论文的任务、数据、方法和指标是否可比，并找出方法差异对实验设计的含义。',
  }),
  gap: Object.freeze({
    label: '3 篇研究缺口',
    minPapers: 3,
    maxPapers: 3,
    goal: '把三篇论文按研究问题与场景聚类，区分共同覆盖、明显空白和结论冲突。',
  }),
  report: Object.freeze({
    label: '综述报告',
    minPapers: 2,
    maxPapers: 3,
    goal: '从有证据的对照结果形成背景、路线、比较、争议、缺口和下一步报告。',
  }),
})

const SURVEY_MODE_SET = new Set(Object.keys(SURVEY_MODES))
const COMPARABILITY_STATUS = Object.freeze({
  comparable: '适合对照',
  limited: '有限可比',
  'not-recommended': '不建议直接对照',
})

/** 综述对照表的固定字段；顺序就是界面上的行顺序。 */
export const COMPARE_FIELDS = [
  { key: 'question', label: '研究问题', hint: '这篇论文要回答什么' },
  { key: 'object', label: '对象与数据', hint: '研究对象、样本、数据集、材料' },
  { key: 'method', label: '方法', hint: '核心方法/模型/实验设计' },
  { key: 'metric', label: '指标', hint: '评价指标或观察量' },
  { key: 'result', label: '主要结果', hint: '带数字的结论，保留原文口径' },
  { key: 'limitation', label: '局限', hint: '作者承认或材料显示的边界' },
  { key: 'relation', label: '与当前问题的关系', hint: '对陛下当前问题的用处，不要泛泛而谈' },
]

/** 引用支持度的四个结论；不允许「看起来像」。 */
export const CITATION_VERDICTS = {
  supports: '支持引用处主张',
  partially: '部分支持',
  conflicts: '与引用处相反',
  insufficient: '证据不足',
}

const VERDICT_ALIASES = {
  support: 'supports',
  supported: 'supports',
  supports: 'supports',
  支持: 'supports',
  partial: 'partially',
  partially: 'partially',
  部分支持: 'partially',
  conflict: 'conflicts',
  conflicts: 'conflicts',
  contradict: 'conflicts',
  相反: 'conflicts',
  冲突: 'conflicts',
  insufficient: 'insufficient',
  unclear: 'insufficient',
  证据不足: 'insufficient',
  不明确: 'insufficient',
}

/** 压空白。 */
function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/** 截断。 */
function clip(value, limit) {
  const text = clean(value)
  if (text.length <= limit) return text
  return text.slice(0, Math.max(0, limit - 1)).trimEnd() + '…'
}

const SURVEY_STOPWORDS = new Set([
  'about',
  'abstract',
  'after',
  'and',
  'also',
  'among',
  'analysis',
  'an',
  'approach',
  'are',
  'as',
  'at',
  'based',
  'be',
  'between',
  'by',
  'could',
  'enough',
  'field',
  'for',
  'from',
  'have',
  'in',
  'into',
  'is',
  'it',
  'method',
  'methods',
  'of',
  'on',
  'paper',
  'comparison',
  'introduction',
  'results',
  'text',
  'useful',
  'long',
  'result',
  'results',
  'study',
  'than',
  'that',
  'their',
  'these',
  'the',
  'this',
  'through',
  'to',
  'using',
  'we',
  'with',
  '研究',
  '方法',
  '结果',
  '论文',
  '本文',
  '基于',
  '一种',
  '分析',
])

export function normalizeSurveyMode(value) {
  const mode = String(value || 'method').toLowerCase()
  return SURVEY_MODE_SET.has(mode) ? mode : 'method'
}

function normalizedIdentity(value) {
  return clean(value).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function surveyTokens(value) {
  const text = clean(value).toLowerCase()
  const raw = text.match(/[\p{L}\p{N}]{2,}/gu) || []
  return new Set(
    raw
      .map((token) => token.replace(/^\d+$/, ''))
      .filter((token) => token.length >= 2 && !SURVEY_STOPWORDS.has(token)),
  )
}

function tokenOverlap(left, right) {
  if (left.size === 0 || right.size === 0) return { score: 0, shared: [] }
  const shared = [...left].filter((token) => right.has(token))
  const union = new Set([...left, ...right])
  return { score: union.size > 0 ? shared.length / union.size : 0, shared }
}

function digestTextForCompatibility(digest) {
  return [
    digest?.abstract || '',
    ...(Array.isArray(digest?.sections) ? digest.sections : []).map(
      (section) => String(section?.title || '') + ' ' + String(section?.gist || ''),
    ),
    ...(Array.isArray(digest?.excerpts) ? digest.excerpts : []).map((excerpt) => excerpt?.text || ''),
  ].join(' ')
}

/**
 * 先做确定性可比性预检，再决定是否值得调用模型。
 * 这不是最终学术判断，而是用来防止把同篇版本或明显不同主题硬塞进七字段表。
 */
export function assessSurveyCompatibility(digests, surveyMode = 'method') {
  const papers = Array.isArray(digests) ? digests : []
  const mode = normalizeSurveyMode(surveyMode)
  const policy = SURVEY_MODES[mode]
  const pairScores = []
  const duplicatePairs = []
  for (let leftIndex = 0; leftIndex < papers.length; leftIndex += 1) {
    const left = papers[leftIndex]
    const leftTitle = surveyTokens(left?.title)
    const leftBody = surveyTokens(digestTextForCompatibility(left))
    for (let rightIndex = leftIndex + 1; rightIndex < papers.length; rightIndex += 1) {
      const right = papers[rightIndex]
      const rightTitle = surveyTokens(right?.title)
      const rightBody = surveyTokens(digestTextForCompatibility(right))
      const title = tokenOverlap(leftTitle, rightTitle)
      const body = tokenOverlap(leftBody, rightBody)
      const sharedTerms = [...new Set([...title.shared, ...body.shared])].slice(0, 8)
      const sameDoi =
        Boolean(normalizedIdentity(left?.doi)) &&
        normalizedIdentity(left?.doi) === normalizedIdentity(right?.doi)
      const sameArxiv =
        Boolean(normalizedIdentity(left?.arxiv)) &&
        normalizedIdentity(left?.arxiv) === normalizedIdentity(right?.arxiv)
      const sameTitle =
        Boolean(normalizedIdentity(left?.title)) &&
        normalizedIdentity(left?.title) === normalizedIdentity(right?.title)
      const likelyVersion = sameDoi || sameArxiv || sameTitle
      if (likelyVersion) {
        duplicatePairs.push({
          jobIds: [left?.jobId || '', right?.jobId || ''],
          reason: sameDoi ? 'same-doi' : sameArxiv ? 'same-arxiv' : 'same-title',
        })
      }
      pairScores.push({
        jobIds: [left?.jobId || '', right?.jobId || ''],
        score: Number((title.score * 0.45 + body.score * 0.55).toFixed(4)),
        titleScore: Number(title.score.toFixed(4)),
        bodyScore: Number(body.score.toFixed(4)),
        sharedTerms,
        likelyVersion,
      })
    }
  }
  const allText = papers.map((paper) => surveyTokens(digestTextForCompatibility(paper)))
  const sharedAcrossAll =
    allText.length > 0
      ? [...allText[0]].filter((token) => allText.slice(1).every((set) => set.has(token))).slice(0, 8)
      : []
  const averageScore =
    pairScores.length > 0
      ? pairScores.reduce((sum, pair) => sum + pair.score, 0) / pairScores.length
      : 0
  const countValid = papers.length >= policy.minPapers && papers.length <= policy.maxPapers
  const reasons = []
  const warnings = []
  if (!countValid) {
    reasons.push(
      policy.label + ' 需要 ' + policy.minPapers + (policy.minPapers === policy.maxPapers ? '' : '–' + policy.maxPapers) + ' 篇论文。',
    )
  }
  if (duplicatePairs.length > 0) {
    reasons.push('选中的论文包含同 DOI/arXiv 或同标题条目，更像同一论文的不同版本。')
  }
  if (averageScore >= 0.045 || sharedAcrossAll.length >= 3) {
    reasons.push('论文标题、摘要或章节存在可见的共同研究词汇。')
  } else if (averageScore >= 0.015 || pairScores.some((pair) => pair.sharedTerms.length >= 2)) {
    reasons.push('论文只有少量共同词汇，能做有限对照，但需要明确设定差异。')
  } else {
    reasons.push('论文之间没有检测到足够的共同研究词汇。')
  }
  if (!countValid || duplicatePairs.length > 0) {
    warnings.push('当前选择不适合按七字段硬比较；可返回重新选文。')
  } else if (averageScore < 0.015 && sharedAcrossAll.length < 3) {
    warnings.push('可比性较低；若仍继续，报告会把跨论文关系标为模型归纳。')
  }
  let status = 'not-recommended'
  if (countValid && duplicatePairs.length === 0) {
    if (averageScore >= 0.045 || sharedAcrossAll.length >= 3) status = 'comparable'
    else if (averageScore >= 0.015 || pairScores.some((pair) => pair.sharedTerms.length >= 2)) {
      status = 'limited'
    }
  }
  return {
    version: COMPARE_PROMPT_VERSION,
    mode,
    label: policy.label,
    goal: policy.goal,
    paperCount: papers.length,
    expectedCount: { min: policy.minPapers, max: policy.maxPapers },
    status,
    statusLabel: COMPARABILITY_STATUS[status],
    canProceed: status !== 'not-recommended',
    score: Number(averageScore.toFixed(4)),
    sharedTerms: [...new Set([...sharedAcrossAll, ...pairScores.flatMap((pair) => pair.sharedTerms)])].slice(0, 10),
    pairScores,
    duplicatePairs,
    reasons,
    warnings,
  }
}

/** 把批注压成给模型看的短行；对照表与工作台对话共用同一口径。 */
function formatAnnotationLines(annotations) {
  const notes = Array.isArray(annotations) ? annotations.slice(0, 8) : []
  return notes.map((item, index) => {
    const title = clip(item?.context?.paper?.title || '', 40)
    const segment = Array.isArray(item?.segments) ? item.segments[0] : null
    const place = segment
      ? 'p.' + (Number(segment.page) || '?') + (segment.blockId ? ' · ' + segment.blockId : '')
      : ''
    const note = clip(item?.question || '（只标记）', 140)
    const quote = clip(segment?.quote || '', 180)
    return (
      '- 批注 ' +
      (index + 1) +
      (title ? '《' + title + '》' : '') +
      (place ? ' · ' + place : '') +
      ' — ' +
      note +
      (quote ? ' — 原文：「' + quote + '」' : '')
    )
  })
}

/** 一篇档案里所有可作为锚点的块：章节标题 + 关键段。 */
export function digestBlockIndex(digest) {
  const index = new Map()
  for (const section of digest?.sections || []) {
    if (!section?.blockId) continue
    index.set(section.blockId, {
      blockId: section.blockId,
      page: Number(section.page) || 0,
      section: section.title || '',
    })
  }
  for (const excerpt of digest?.excerpts || []) {
    if (!excerpt?.blockId) continue
    index.set(excerpt.blockId, {
      blockId: excerpt.blockId,
      page: Number(excerpt.page) || 0,
      section: excerpt.section || '',
    })
  }
  return index
}

/** 把模型给的单元格（字符串或对象）统一成 {text, blockIds}。 */
function coerceCell(value) {
  if (typeof value === 'string') return { text: clean(value), blockIds: [] }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { text: '', blockIds: [] }
  const text = value.text ?? value.value ?? value.summary ?? value.content ?? ''
  const blockIds = Array.isArray(value.blockIds)
    ? value.blockIds
    : Array.isArray(value.blocks)
      ? value.blocks
      : value.blockId
        ? [value.blockId]
        : []
  return {
    text: clean(text),
    blockIds: blockIds.map((id) => String(id || '')).filter(Boolean),
  }
}

function normalizeSurveyEvidence(rawEvidence, indexes) {
  const evidence = []
  const seen = new Set()
  for (const item of Array.isArray(rawEvidence) ? rawEvidence : []) {
    const jobId = String(item?.jobId || '')
    const index = indexes.get(jobId)
    if (!index) continue
    const ids = Array.isArray(item?.blockIds)
      ? item.blockIds
      : item?.blockId
        ? [item.blockId]
        : []
    for (const blockIdValue of ids) {
      const blockId = String(blockIdValue || '')
      const locator = index.get(blockId)
      if (!locator) continue
      const key = jobId + ':' + blockId
      if (seen.has(key)) continue
      seen.add(key)
      evidence.push({
        jobId,
        blockId,
        page: locator.page,
        section: locator.section,
        quote: clip(item?.quote, 220),
      })
    }
  }
  return evidence
}

function evidenceJobIds(evidence) {
  return [...new Set((Array.isArray(evidence) ? evidence : []).map((item) => item.jobId))]
}

/**
 * 校验并规范化综述对照表。模型必须给 blockId；给不出就标「未定位」，不伪造。
 * @param {unknown} raw - 模型 JSON。
 * @param {object[]} digests - 2–3 篇档案。
 * @returns {object} 可直接渲染的表格 + 统计 + 告警。
 */
export function normalizeComparisonTable(raw, digests, options = {}) {
  const surveyMode = normalizeSurveyMode(options.surveyMode || raw?.mode)
  const preflight =
    options.preflight ||
    raw?.preflight ||
    assessSurveyCompatibility(digests, surveyMode)
  const papers = Array.isArray(raw?.papers) ? raw.papers : []
  const byJob = new Map()
  for (const paper of papers) {
    if (paper?.jobId) byJob.set(String(paper.jobId), paper)
  }
  const indexes = new Map(digests.map((digest) => [digest.jobId, digestBlockIndex(digest)]))
  let grounded = 0
  let ungrounded = 0
  let missing = 0
  const fields = COMPARE_FIELDS.map((field) => ({
    key: field.key,
    label: field.label,
    hint: field.hint,
    cells: digests.map((digest, index) => {
      const paper = byJob.get(digest.jobId) || papers[index] || {}
      const cell = coerceCell(paper?.fields?.[field.key])
      const validIds = [...new Set(cell.blockIds.filter((id) => indexes.get(digest.jobId)?.has(id)))]
      const text = clip(cell.text, 520)
      const isEmpty = !text || text === '未找到' || text === '未找到。'
      const isGrounded = !isEmpty && validIds.length > 0
      if (isEmpty) missing += 1
      else if (isGrounded) grounded += 1
      else ungrounded += 1
      return {
        jobId: digest.jobId,
        title: digest.title,
        text: isEmpty ? '未找到' : text,
        blockIds: validIds,
        grounded: isGrounded,
        missing: isEmpty,
      }
    }),
  }))
  const warnings = []
  if (ungrounded > 0) {
    warnings.push(ungrounded + ' 个单元格没有有效 blockId，已标为「未定位」，不要当成已核对结论')
  }
  if (missing > 0) warnings.push(missing + ' 个单元格在给定材料里找不到依据')
  const relations = []
  for (const item of Array.isArray(raw?.relations) ? raw.relations : []) {
    const evidence = normalizeSurveyEvidence(item?.evidence, indexes)
    if (evidence.length === 0) continue
    relations.push({
      type: ['shared', 'difference', 'conflict', 'complement'].includes(item?.type)
        ? item.type
        : 'difference',
      text: clip(item?.text, 520),
      evidence,
      grounded: true,
    })
  }
  const gaps = []
  let gapsGrounded = 0
  let gapsInference = 0
  for (const item of Array.isArray(raw?.gaps) ? raw.gaps : []) {
    const text = clip(item?.text, 620)
    if (!text) continue
    const evidence = normalizeSurveyEvidence(item?.support || item?.evidence, indexes)
    const inference = ['model-inference', 'synthesis', 'hypothesis'].includes(String(item?.kind || ''))
    if (inference) {
      gapsInference += 1
      gaps.push({
        text,
        kind: 'model-inference',
        evidence,
        nextStep: clip(item?.nextStep || item?.next, 260),
        noveltyCheck: clip(item?.noveltyCheck || 'not-run', 80),
      })
      continue
    }
    if (evidenceJobIds(evidence).length < 2) {
      warnings.push('一个研究缺口少于两篇论文的有效证据，已从报告事实区丢弃：' + clip(text, 80))
      continue
    }
    gapsGrounded += 1
    gaps.push({
      text,
      kind: 'grounded',
      evidence,
      nextStep: clip(item?.nextStep || item?.next, 260),
      noveltyCheck: clip(item?.noveltyCheck || 'not-run', 80),
    })
  }
  const comparableCells = grounded + ungrounded
  return {
    version: COMPARE_PROMPT_VERSION,
    surveyMode,
    taskLabel: SURVEY_MODES[surveyMode].label,
    goal: SURVEY_MODES[surveyMode].goal,
    papers: digests.map((digest) => ({ jobId: digest.jobId, title: digest.title })),
    preflight,
    fields,
    relations,
    gaps,
    stats: {
      grounded,
      ungrounded,
      missing,
      total: fields.length * digests.length,
      anchorRate: comparableCells > 0 ? Number((grounded / comparableCells).toFixed(4)) : 0,
      relations: relations.length,
      gapsGrounded,
      gapsInference,
    },
    warnings,
  }
}

function paperAliases(table) {
  return new Map(
    (Array.isArray(table?.papers) ? table.papers : []).map((paper, index) => [
      paper.jobId,
      { alias: 'P' + (index + 1), title: paper.title || paper.jobId },
    ]),
  )
}

function evidenceLabel(evidence, aliases) {
  return (Array.isArray(evidence) ? evidence : [])
    .map((item) => {
      const paper = aliases.get(item.jobId)
      return paper ? paper.alias + ' ' + item.blockId : item.blockId
    })
    .filter(Boolean)
    .join('、')
}

/**
 * 从已经通过 blockId 校验的对照表生成综述报告。
 * 报告事实段只写 grounded 内容；未定位和模型归纳进入独立区，避免把无出处内容混进结论。
 */
export function buildSurveyReport({ table, preflight = null, title = '' }) {
  const aliases = paperAliases(table)
  const lines = []
  const task = table?.taskLabel || SURVEY_MODES[normalizeSurveyMode(table?.surveyMode)].label
  lines.push('# ' + (title || '多篇论文综述报告'))
  lines.push('')
  lines.push('> 任务：' + task)
  const effectivePreflight = preflight || table?.preflight || null
  if (effectivePreflight) {
    lines.push(
      '> 可比性：' +
        effectivePreflight.statusLabel +
        '；共同研究词：' +
        (effectivePreflight.sharedTerms.length ? effectivePreflight.sharedTerms.join('、') : '未检出'),
    )
    for (const reason of effectivePreflight.reasons || []) lines.push('> - ' + reason)
  }
  lines.push('')
  lines.push('## 论文范围')
  for (const [jobId, paper] of aliases) {
    lines.push('- ' + paper.alias + '：' + paper.title + '（jobId=' + jobId + '）')
  }
  lines.push('')
  lines.push('## 有原文证据的对照')
  for (const field of Array.isArray(table?.fields) ? table.fields : []) {
    const groundedCells = field.cells.filter((cell) => cell.grounded && !cell.missing)
    if (groundedCells.length === 0) continue
    lines.push('### ' + field.label)
    for (const cell of groundedCells) {
      const paper = aliases.get(cell.jobId)
      lines.push(
        '- ' +
          (paper?.alias || '论文') +
          '：' +
          cell.text +
          ' [' +
          evidenceLabel(
            cell.blockIds.map((blockId) => ({ jobId: cell.jobId, blockId })),
            aliases,
          ) +
          ']',
      )
    }
    lines.push('')
  }
  const groundedRelations = (Array.isArray(table?.relations) ? table.relations : []).filter(
    (relation) => relation.grounded && relation.evidence.length > 0,
  )
  if (groundedRelations.length > 0) {
    lines.push('## 跨论文关系（有证据）')
    for (const relation of groundedRelations) {
      lines.push(
        '- ' +
          ({
            shared: '共同覆盖',
            difference: '设定/方法差异',
            conflict: '结论冲突',
            complement: '互补关系',
          }[relation.type] || '关系') +
          '：' +
          relation.text +
          ' [' +
          evidenceLabel(relation.evidence, aliases) +
          ']',
      )
    }
    lines.push('')
  }
  const groundedGaps = (Array.isArray(table?.gaps) ? table.gaps : []).filter(
    (gap) => gap.kind === 'grounded',
  )
  const inferenceGaps = (Array.isArray(table?.gaps) ? table.gaps : []).filter(
    (gap) => gap.kind === 'model-inference',
  )
  if (groundedGaps.length > 0) {
    lines.push('## 可验证研究缺口')
    for (const gap of groundedGaps) {
      lines.push('- ' + gap.text + ' [' + evidenceLabel(gap.evidence, aliases) + ']')
      if (gap.nextStep) lines.push('  - 下一步：' + gap.nextStep)
      lines.push('  - 查新状态：' + (gap.noveltyCheck === 'not-run' ? '未查新' : gap.noveltyCheck))
    }
    lines.push('')
  }
  if (inferenceGaps.length > 0) {
    lines.push('## 模型归纳（需人工验证，不作为论文事实）')
    for (const gap of inferenceGaps) {
      lines.push('- ' + gap.text)
      if (gap.evidence.length > 0) lines.push('  - 相关原文：' + evidenceLabel(gap.evidence, aliases))
      if (gap.nextStep) lines.push('  - 可验证方式：' + gap.nextStep)
      lines.push('  - 查新状态：' + (gap.noveltyCheck === 'not-run' ? '未查新' : gap.noveltyCheck))
    }
    lines.push('')
  }
  const ungrounded = []
  for (const field of Array.isArray(table?.fields) ? table.fields : []) {
    for (const cell of field.cells) {
      if (cell.grounded || cell.missing) continue
      ungrounded.push({ field: field.label, cell })
    }
  }
  lines.push('## 证据边界')
  lines.push(
    '- 已定位单元格：' +
      (table?.stats?.grounded || 0) +
      '/' +
      (table?.stats?.total || 0) +
      '；未定位：' +
      (table?.stats?.ungrounded || 0) +
      '；未找到：' +
      (table?.stats?.missing || 0) +
      '。',
  )
  lines.push('- 本报告只把有 blockId 的单元格和关系写入事实区；模型归纳已独立标注。')
  if (ungrounded.length > 0) {
    lines.push(
      '- 待核对文字：' +
        ungrounded
          .slice(0, 12)
          .map((item) => item.field + ' / ' + item.cell.text)
          .join('；'),
    )
  }
  return {
    markdown: lines.join('\n').trim() + '\n',
    stats: {
      groundedRelations: groundedRelations.length,
      groundedGaps: groundedGaps.length,
      inferenceGaps: inferenceGaps.length,
      unsourcedFacts: 0,
      ungroundedCells: ungrounded.length,
    },
  }
}

/**
 * 校验引用关系结论。证据必须有被引论文里的 blockId；没有证据就降级为「证据不足」。
 * @param {unknown} raw - 模型 JSON。
 * @param {{digests: object[], citingJobId: string}} options - 档案与引用方。
 * @returns {object} 可渲染的关系卡。
 */
export function normalizeCitationVerdict(raw, { digests, citingJobId }) {
  const cited = digests.find((digest) => digest.jobId !== citingJobId) || digests[digests.length - 1]
  const index = digestBlockIndex(cited)
  const evidence = []
  for (const item of Array.isArray(raw?.evidence) ? raw.evidence : []) {
    const blockId = String(item?.blockId || item?.id || '')
    if (!index.has(blockId)) continue
    evidence.push({
      jobId: cited.jobId,
      blockId,
      page: index.get(blockId).page,
      section: index.get(blockId).section,
      quote: clip(item?.quote || item?.text, 240),
    })
    if (evidence.length >= 4) break
  }
  const requested = VERDICT_ALIASES[clean(raw?.verdict).toLowerCase()] || VERDICT_ALIASES[clean(raw?.verdict)]
  const verdict = evidence.length === 0 ? 'insufficient' : requested || 'insufficient'
  const warnings = []
  if (evidence.length === 0) warnings.push('模型没有给出被引论文里的有效 blockId，按「证据不足」处理')
  return {
    version: COMPARE_PROMPT_VERSION,
    verdict,
    label: CITATION_VERDICTS[verdict],
    claim: clip(raw?.claim, 500),
    citedContribution: clip(raw?.citedContribution || raw?.contribution, 700),
    gap: clip(raw?.gap || raw?.missingLink, 500),
    nextSection: clip(raw?.nextSection || raw?.next, 200),
    evidence,
    grounded: evidence.length > 0,
    warnings,
  }
}

/** 综述提示词：要求结构化对照，并明确区分「设定不同」与「真正冲突」。 */
export function buildSurveyPrompt({
  digests,
  surveyMode = 'method',
  preflight = null,
}) {
  const mode = normalizeSurveyMode(surveyMode)
  const policy = SURVEY_MODES[mode]
  const compatibility = preflight || assessSurveyCompatibility(digests, mode)
  const system = [
    '你是论文对照分析器。只输出 JSON，不要 Markdown。',
    '你只能使用给定的论文档案；不得引入外部知识，不得编造数字、实验或结论。',
    '每个字段都必须给 blockIds，且只能从该论文的章节/关键段 blockId 里选；找不到依据就写 text="未找到"、blockIds=[]。',
    '把「研究设定不同」与「结论真正冲突」分开：样本、任务、指标不同，不等于结论矛盾。',
    '数字保留原文口径与单位；不要做单位换算，除非原文给了换算。',
    '本次任务：' + policy.label + '。目标：' + policy.goal,
    '无论任务类型是什么，papers[].fields 的七个字段都必须逐篇填写；研究缺口和跨论文关系不能替代基础对照表。',
    '跨论文关系必须给至少一条有效证据；研究缺口若没有至少两篇不同论文的有效证据，kind 必须写 model-inference。',
    '不要输出逐篇摘要拼接。优先输出跨论文的共同覆盖、差异、冲突、互补和可验证缺口。',
  ].join('\n')
  const schema = [
    '输出 JSON 形状：',
    '{"papers":[{"jobId":"...","fields":{',
    ...COMPARE_FIELDS.map((field) => '"' + field.key + '":{"text":"...","blockIds":["b0002"]}'),
    '}}],',
    '"relations":[{"type":"shared|difference|conflict|complement","text":"跨论文关系","evidence":[{"jobId":"...","blockId":"b0002","quote":"原文短句"}]}],',
    '"gaps":[{"text":"具体可验证缺口","kind":"grounded|model-inference","support":[{"jobId":"...","blockId":"b0002"}],"nextStep":"下一步实验/检索建议","noveltyCheck":"not-run"}],',
    '"notes":["..."]}',
    '字段含义：' + COMPARE_FIELDS.map((field) => field.key + '=' + field.label + '（' + field.hint + '）').join('；'),
    '关系类型：shared=共同覆盖，difference=设定/方法不同，conflict=真正相反，complement=互补。',
    '缺口规则：grounded 至少需要两篇不同论文的 support；只来自单篇或模型推理时必须写 model-inference。',
  ].join('\n')
  const material = digests.map((digest, index) => digestToText(digest, 'P' + (index + 1))).join('\n\n')
  return {
    system,
    user:
      schema +
      '\n\n确定性可比性预检：\n' +
      JSON.stringify(compatibility, null, 2) +
      '\n\n论文档案：\n\n' +
      material,
    maxTokens: 4200,
  }
}

/** 引用提示词：只判断一条引用链，不展开整篇综述。 */
export function buildCitationPrompt({ digests, citing }) {
  const system = [
    '你是引用链审计器。只输出 JSON，不要 Markdown。',
    '任务：判断引用处的主张是否被被引论文实际支持。只能使用给定材料，不得引入外部知识。',
    'verdict 只能是 supports / partially / conflicts / insufficient 之一。',
    '材料里有两篇：引用方 A 与被引论文 B。A 只用于确定「引用处的主张」，B 才是证据来源。',
    'evidence 只能来自 B 的 blockId；把 A 的内容当成 B 的证据是严重错误。没有 B 的有效证据时必须给 insufficient。',
    '区分「被引论文没研究这个问题」与「研究了但结论相反」；前者是 insufficient，不是 conflicts。',
  ].join('\n')
  const schema = [
    '输出 JSON 形状：',
    '{"verdict":"supports|partially|conflicts|insufficient","claim":"引用处的主张",',
    '"citedContribution":"被引论文实际做了什么/结论",',
    '"gap":"逻辑链缺的那一环（没有就写空字符串）",',
    '"evidence":[{"jobId":"...","blockId":"b0002","quote":"原文短句"}],',
    '"nextSection":"建议核对被引论文的哪一节"}',
  ].join('\n')
  const citingDigest = digests.find((digest) => digest.jobId === citing.jobId) || digests[0]
  const citedDigest = digests.find((digest) => digest.jobId !== citing.jobId) || digests[1] || digests[0]
  const material = [
    '【引用方 A】jobId=' + citingDigest.jobId,
    digestToText(citingDigest, 'A'),
    '',
    '【被引论文 B】jobId=' + citedDigest.jobId,
    digestToText(citedDigest, 'B'),
  ].join('\n')
  const quote = [
    '引用处：',
    '引用方 A jobId=' + citing.jobId,
    '被引论文 B jobId=' + citedDigest.jobId,
    'blockId=' + citing.blockId,
    citing.section ? '章节=' + citing.section : '',
    citing.page ? '页码=' + citing.page : '',
    '原文：「' + clip(citing.text, 1200) + '」',
  ]
    .filter(Boolean)
    .join('\n')
  return {
    system,
    user:
      schema +
      '\n\n' +
      quote +
      '\n\n注意：evidence[].jobId 必须填 B 的 jobId（' +
      citedDigest.jobId +
      '），不得填 A。\n\n' +
      material,
    maxTokens: 2000,
  }
}

/** 缓存键：论文集合 + 模式 + 引用位置 + 两个版本号。 */
export function compareKey({ jobIds, mode = 'survey', citing = null, surveyMode = '' }) {
  const ids = [...new Set((jobIds || []).map(String))].sort()
  const cite = citing ? String(citing.jobId || '') + ':' + String(citing.blockId || '') : ''
  return [
    'digest=' + DIGEST_VERSION,
    'prompt=' + COMPARE_PROMPT_VERSION,
    'mode=' + mode,
    'survey=' + (mode === 'survey' ? normalizeSurveyMode(surveyMode) : ''),
    'papers=' + ids.join(','),
    'citing=' + cite,
  ].join('|')
}

function comparableBlocks(doc) {
  return (Array.isArray(doc?.blocks) ? doc.blocks : [])
    .filter((block) => ['paragraph', 'text', 'heading'].includes(block?.type) && String(block.text || '').trim())
    .map((block) => ({
      blockId: String(block.id || ''),
      page: Number(block.page) || 0,
      section: clip(block.section, 120),
      text: clean(block.text),
    }))
    .slice(0, 400)
}

/**
 * 同篇多版本的段落级差异：确定性 LCS，不做语义猜测。
 * @param {object} leftDoc - 左版本 MirrorDoc。
 * @param {object} rightDoc - 右版本 MirrorDoc。
 * @returns {object} added / removed / unchanged。
 */
export function buildVersionDiff(leftDoc, rightDoc) {
  const left = comparableBlocks(leftDoc)
  const right = comparableBlocks(rightDoc)
  const dp = Array.from({ length: left.length + 1 }, () => new Array(right.length + 1).fill(0))
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      dp[i][j] =
        left[i - 1].text === right[j - 1].text
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  let i = left.length
  let j = right.length
  const matchedLeft = new Set()
  const matchedRight = new Set()
  while (i > 0 && j > 0) {
    if (left[i - 1].text === right[j - 1].text) {
      matchedLeft.add(i - 1)
      matchedRight.add(j - 1)
      i -= 1
      j -= 1
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i -= 1
    } else {
      j -= 1
    }
  }
  const added = right
    .filter((_, index) => !matchedRight.has(index))
    .map((block) => ({ ...block, text: block.text.slice(0, 360) }))
  const removed = left
    .filter((_, index) => !matchedLeft.has(index))
    .map((block) => ({ ...block, text: block.text.slice(0, 360) }))
  return {
    left: {
      jobId: String(leftDoc?.meta?.jobId || ''),
      title: clip(leftDoc?.meta?.title, 180),
      version: {
        kind: clip(leftDoc?.version?.kind || 'unknown', 24),
        label: clip(leftDoc?.version?.label || '版本未核验', 80),
      },
    },
    right: {
      jobId: String(rightDoc?.meta?.jobId || ''),
      title: clip(rightDoc?.meta?.title, 180),
      version: {
        kind: clip(rightDoc?.version?.kind || 'unknown', 24),
        label: clip(rightDoc?.version?.label || '版本未核验', 80),
      },
    },
    added,
    removed,
    unchanged: matchedLeft.size,
  }
}

/** 把对照表压成几行，放进主对话消息里，避免模型再花一次调用生成同一张表。 */
export function buildCompactTableText(table) {
  if (!table?.fields?.length) return ''
  const lines = ['对照表（已定位的单元格）：']
  for (const field of table.fields) {
    const cells = field.cells
      .map(
        (cell, index) =>
          'P' +
          (index + 1) +
          ' ' +
          cell.text +
          (cell.grounded || cell.missing ? '' : '（未定位）'),
      )
      .join(' ｜ ')
    lines.push('- ' + field.label + '：' + cells)
  }
  return lines.join('\n')
}

/**
 * 生成主对话里的对照包消息。用户消息保持可读，完整档案由 doraemon_read_papers 取。
 * @param {object} options - mode/digests/citing/question/table。
 * @returns {string} 用户消息 Markdown。
 */
export function buildCompareMessage({
  mode = 'survey',
  digests,
  citing = null,
  question = '',
  table = null,
  annotations = [],
  surveyMode = 'method',
  preflight = null,
}) {
  const lines = []
  const ids = digests.map((digest) => digest.jobId)
  if (mode === 'citation' && citing) {
    lines.push('🔗 引用对照 · ' + (citing.title || '当前论文') + ' [' + (citing.number || '?') + '] → 被引论文')
    lines.push(
      '引用处：jobId=' + citing.jobId + ' · blockId=' + citing.blockId + (citing.page ? ' · p.' + citing.page : ''),
    )
    if (citing.text) lines.push('原文：「' + clip(citing.text, 260) + '」')
  } else {
    lines.push('🧭 多篇对照 · ' + SURVEY_MODES[normalizeSurveyMode(surveyMode)].label + ' · ' + digests.length + ' 篇')
  }
  digests.forEach((digest, index) => {
    const role =
      mode === 'citation' && citing
        ? digest.jobId === citing.jobId
          ? '（引用方 A）'
          : '（被引论文 B）'
        : ''
    lines.push('・P' + (index + 1) + '《' + clip(digest.title, 80) + '》 jobId=' + digest.jobId + role)
  })
  const asked = clip(question, 300)
  if (asked) lines.push('', '整体问题：' + asked)
  const notes = Array.isArray(annotations) ? annotations.slice(0, 8) : []
  if (notes.length > 0) {
    lines.push('', '附带的跨论文批注（' + notes.length + ' 条）：')
    lines.push(...formatAnnotationLines(notes))
    lines.push('这些批注来自不同论文：先按论文归属理解，再回答整体问题；引用时标明论文与 blockId。')
  }
  if (table?.stats) {
    lines.push(
      '',
      '界面已生成对照表：' +
        table.stats.grounded +
        '/' +
        table.stats.total +
        ' 个单元格有 blockId；未定位的单元格不要当成结论。',
    )
  }
  if (mode === 'survey' && preflight) {
    lines.push(
      '',
      '可比性预检：' +
        preflight.statusLabel +
        '（分数 ' +
        preflight.score +
        '）；共同词：' +
        (preflight.sharedTerms.length ? preflight.sharedTerms.join('、') : '未检出') +
        '。',
    )
    if (preflight.warnings.length > 0) lines.push('预检提醒：' + preflight.warnings.join('；'))
  }
  lines.push(
    '',
    '请先调用 doraemon_read_papers，jobIds 用：' + JSON.stringify(ids) + '。',
    mode === 'citation'
      ? [
          '回答规则：',
          '1. 先说 A 在引用处的主张（用 A 的原文，不要改写口径）。',
          '2. 再说 B 实际做了什么、结论是什么，必须带 B 的 blockId；A 的内容不能当作 B 的证据。',
          '3. 给支持度：支持 / 部分支持 / 相反 / 证据不足，并说明缺哪一环。',
          '4. 说明这条引用在研究方向上的作用：背景铺垫、方法借用、对照，还是关键证据。',
          '5. 建议核对 B 的哪一节。',
        ].join('\n')
      : [
          '回答规则：',
          '1. 先说明论文为什么可比或只能有限可比，再回答问题。',
          '2. 先给跨论文关系，再给逐字段对照：研究问题 / 对象与数据 / 方法 / 指标 / 主要结果 / 局限 / 与整体问题的关系。',
          '3. 每个结论后面标 `[P1 b0002]` 这样的论文编号 + blockId；没有依据写「未找到」，不要猜。',
          '4. 把「研究设定不同」与「结论真正冲突」分开说。',
          '5. 研究缺口必须有至少两篇论文的证据；否则明确标为「模型归纳」。',
          '6. 最后给一句：下一步该读哪一篇的哪一节。',
        ].join('\n'),
    '引用原文时优先用 dsh-resource://doraemon-paper/<jobId>/<blockId> 链接；不要改写成文件路径。',
  )
  return lines.join('\n')
}

/**
 * 对照工作台的对话提示词。与主对话的对照包不同：这里直接给模型档案与历史，
 * 回答会回到工作台消息列表，不再经过工具取档。
 * @param {object} options - mode/digests/citing/annotations/question/history。
 * @returns {{system: string, user: string, maxTokens: number}} 提示词。
 */
export function buildCompareChatPrompt({
  mode = 'survey',
  digests,
  citing = null,
  annotations = [],
  question = '',
  history = [],
  surveyMode = 'method',
  preflight = null,
}) {
  const system = [
    '你是大肥鱼论文对照工作台。只使用给定的论文档案与批注，不得引入外部知识，不得编造数字、实验或结论。',
    '输出中文 Markdown，先给结论，再给证据；每个结论后标 `[P1 b0002]` 这样的论文编号 + blockId。',
    '找不到依据就写「未找到」，不要用常识补齐。',
    '把「研究设定不同」与「结论真正冲突」分开：样本、任务、指标不同，不等于结论矛盾。',
    buildQaSystemContract({
      question,
      annotations,
      evidenceMode: 'paper-only',
    }),
    mode === 'citation'
      ? '这是引用对照：A 是引用方，B 是被引论文；关于 B 的结论只能引用 B 的 blockId，A 的内容不能当作 B 的证据。'
      : '这是' +
        SURVEY_MODES[normalizeSurveyMode(surveyMode)].label +
        '：优先给跨论文的共同点、差异、证据强弱和下一步该读哪一节。' +
        '研究缺口必须有至少两篇论文的 blockId 证据；没有时明确标为「模型归纳」。',
    '用户要求表格、数据图或逻辑图时，先用文字列出结构和字段；界面会另开浮窗渲染，不要把不存在的数字画进图里。',
  ].join('\n')
  const material = digests.map((digest, index) => digestToText(digest, 'P' + (index + 1))).join('\n\n')
  const historyLines = (Array.isArray(history) ? history : [])
    .slice(-8)
    .filter((item) => item && typeof item.content === 'string')
    .map((item) => (item.role === 'assistant' ? '【助手】' : '【用户】') + clip(item.content, 1200))
  const noteLines = formatAnnotationLines(annotations)
  const lines = []
  if (mode === 'citation' && citing) {
    lines.push(
      '引用处：A jobId=' +
        citing.jobId +
        ' · blockId=' +
        citing.blockId +
        (citing.page ? ' · p.' + citing.page : ''),
    )
    if (citing.text) lines.push('原文：「' + clip(citing.text, 1200) + '」')
    lines.push('')
  }
  lines.push('论文档案：', material)
  if (noteLines.length > 0) {
    lines.push('', '随本次提问附带的跨论文批注：', ...noteLines)
  }
  if (mode === 'survey' && preflight) {
    lines.push(
      '',
      '可比性预检：' +
        preflight.statusLabel +
        '；共同词：' +
        (preflight.sharedTerms.length ? preflight.sharedTerms.join('、') : '未检出') +
        '；提醒：' +
        (preflight.warnings.length ? preflight.warnings.join('；') : '无'),
    )
  }
  if (historyLines.length > 0) {
    lines.push('', '最近对话：', ...historyLines)
  }
  lines.push('', '当前问题：' + clip(question, 2000))
  return { system, user: lines.join('\n'), maxTokens: 2400 }
}

/**
 * 模型数据图规划提示词：只允许选已有数字，每个点必须带 blockId 与原文。
 * @param {object} options - digests/table/question。
 * @returns {{system: string, user: string, maxTokens: number}} 提示词。
 */
export function buildChartPrompt({ digests, table = null, question = '' }) {
  const system = [
    '你是论文数据图规划器。只输出 JSON，不要 Markdown。',
    '只能使用给定对照表和论文档案里已经出现的数字；不得计算、换算或编造新数字。',
    '每个数据点必须带 source.jobId、source.blockId、source.quote；quote 必须包含该数字的原文写法。',
    '找不到可画的一致数据就返回空 series，并说明原因。',
    '图类型只允许 bar 或 line；最多 4 个系列、每个系列最多 12 个点。',
  ].join('\n')
  const schema = [
    '输出 JSON 形状：',
    '{"title":"图标题","type":"bar|line","unit":"单位",',
    '"series":[{"label":"系列名","points":[{"label":"刻度名","value":0.42,',
    '"source":{"jobId":"...","blockId":"b0002","quote":"原文含该数字的短句"}}]}],',
    '"note":"取数说明"}',
  ].join('\n')
  const material = [
    table?.fields?.length ? '对照表：\n' + tablePromptText(table) : '（没有对照表）',
    '论文档案：\n' + digests.map((digest, index) => digestToText(digest, 'P' + (index + 1))).join('\n\n'),
    '用户想看的图：' + clip(question, 300),
  ].join('\n\n')
  return { system, user: schema + '\n\n' + material, maxTokens: 2200 }
}

function numericKey(value) {
  return String(value ?? '').replace(/,/g, '').replace(/\s+/g, '').trim()
}

function tablePromptText(table) {
  if (!table?.fields?.length) return ''
  return table.fields
    .map(
      (field) =>
        '- ' +
        field.label +
        '：' +
        field.cells
          .map(
            (cell, index) =>
              'P' +
              (index + 1) +
              ' ' +
              cell.text +
              (cell.blockIds?.length ? ' [' + cell.blockIds.join(',') + ']' : ''),
          )
          .join(' ｜ '),
    )
    .join('\n')
}

/**
 * 校验模型图表：所有点必须落在已有材料上；无效点丢弃，不补造。
 * @param {unknown} raw - 模型 JSON。
 * @param {{digests: object[], table?: object}} options - 材料。
 * @returns {object} 可渲染的图表。
 */
export function normalizeChartSpec(raw, { digests, table = null }) {
  const tableText = table?.fields
    ? table.fields.flatMap((field) => field.cells.map((cell) => cell.text)).join(' ')
    : ''
  const allowed = digests.map((digest) => ({
    digest,
    index: digestBlockIndex(digest),
    text: numericKey(
      [tableText, digest.abstract, ...digest.excerpts.map((item) => item.text)].join(' '),
    ),
  }))
  const byJob = new Map(allowed.map((item) => [item.digest.jobId, item]))
  const series = []
  let dropped = 0
  let total = 0
  for (const rawSeries of (Array.isArray(raw?.series) ? raw.series : []).slice(0, 4)) {
    const points = []
    for (const point of (Array.isArray(rawSeries?.points) ? rawSeries.points : []).slice(0, 12)) {
      total += 1
      const jobId = String(point?.source?.jobId || '')
      const blockId = String(point?.source?.blockId || '')
      const quote = clean(point?.source?.quote)
      const material = byJob.get(jobId)
      const value = Number(point?.value)
      if (!material || !material.index.has(blockId) || !quote || !Number.isFinite(value)) {
        dropped += 1
        continue
      }
      const key = numericKey(point?.value)
      const quoteKey = numericKey(quote)
      if (!key || !material.text.includes(key) || !material.text.includes(quoteKey)) {
        dropped += 1
        continue
      }
      points.push({
        label: clip(point?.label, 80),
        value,
        jobId,
        blockId,
        quote: clip(quote, 200),
        page: material.index.get(blockId).page,
      })
    }
    if (points.length > 0) series.push({ label: clip(rawSeries?.label, 80), points })
  }
  const warnings = []
  if (dropped > 0) warnings.push(dropped + ' 个数据点没有找到可核对的原文，已丢弃')
  if (series.length === 0) warnings.push('没有可画的一致数据；请回到表格里核对数字')
  return {
    title: clip(raw?.title, 120) || '模型数据图',
    type: raw?.type === 'line' ? 'line' : 'bar',
    unit: clip(raw?.unit, 30),
    note: clip(raw?.note, 300),
    series,
    warnings,
    stats: { total, kept: total - dropped, dropped },
  }
}

/**
 * 自由概念图提示词：模型可以组织观点、因果与流程，但论文事实必须回指 blockId。
 * 没有来源的节点会由 normalizeConceptSpec 明确标成「模型归纳」，不能伪装成原文。
 * @param {{digests: object[], question?: string}} options - 两篇论文档案与用户想画的内容。
 * @returns {{system: string, user: string, maxTokens: number}} 提示词。
 */
export function buildConceptPrompt({ digests, question = '' }) {
  const system = [
    '你是论文概念图规划器。只输出 JSON，不要 Markdown，不要输出图片像素。',
    '你可以在给定论文材料范围内组织问题、方法、证据、结论、局限、缺口和研究机会之间的关系。',
    '论文事实或直接概括必须提供 source.jobId、source.blockId、source.quote；quote 必须来自该 blockId 对应的原文。',
    '无法逐字定位的跨论文归纳可以省略 source，但界面会明确标成「模型归纳」；不要把归纳写成论文原话。',
    '不要在无来源节点里写数字、百分比、实验规模或其他定量断言。',
    '节点最多 12 个、关系最多 24 条；边的两端必须引用节点 id。',
  ].join('\n')
  const schema = [
    '输出 JSON 形状：',
    '{"title":"概念图标题","summary":"一句话说明这张图回答什么",',
    '"nodes":[{"id":"n1","label":"短标题","detail":"最多两句解释",',
    '"kind":"problem|method|evidence|result|gap|synthesis",',
    '"source":{"jobId":"...","blockId":"b0002","quote":"对应原文短句"}}],',
    '"edges":[{"from":"n1","to":"n2","label":"支持/对比/导致/需要验证"}]}',
  ].join('\n')
  const material = digests
    .map((digest, index) => digestToText(digest, 'P' + (index + 1)))
    .join('\n\n')
  return {
    system,
    user:
      schema +
      '\n\n用户想画的内容：' +
      clip(question || '请把这些论文的论证结构画成一张可核对的概念图', 400) +
      '\n\n论文材料：\n' +
      material,
    maxTokens: 2600,
  }
}

const CONCEPT_NODE_KINDS = new Set(['problem', 'method', 'evidence', 'result', 'gap', 'synthesis'])

function conceptMaterials(digest) {
  const blocks = new Map()
  const append = (blockId, page, section, text) => {
    const id = String(blockId || '')
    if (!id) return
    const previous = blocks.get(id)
    const nextText = clean([previous?.text, text].filter(Boolean).join(' '))
    blocks.set(id, {
      blockId: id,
      page: Number(page) || previous?.page || 0,
      section: clip(section || previous?.section, 100),
      text: nextText,
    })
  }
  for (const section of digest?.sections || []) {
    append(section?.blockId, section?.page, section?.title, [section?.title, section?.gist].filter(Boolean).join(' '))
  }
  for (const excerpt of digest?.excerpts || []) {
    append(excerpt?.blockId, excerpt?.page, excerpt?.section, excerpt?.text)
  }
  return blocks
}

/**
 * 校验自由概念图。有效锚点保留原文身份；无效锚点降级为「模型归纳」，
 * 无来源且含数字的节点直接丢弃，避免把模型估计伪装成论文数据。
 * @param {unknown} raw - 模型 JSON。
 * @param {{digests: object[]}} options - 两篇论文档案。
 * @returns {object} 可由界面渲染的概念图。
 */
export function normalizeConceptSpec(raw, { digests }) {
  const papers = new Map(
    (Array.isArray(digests) ? digests : []).map((digest) => [
      String(digest?.jobId || ''),
      { digest, blocks: conceptMaterials(digest) },
    ]),
  )
  const nodes = []
  const ids = new Set()
  const warnings = []
  let dropped = 0
  let invalidAnchors = 0
  let total = 0
  for (const [index, item] of (Array.isArray(raw?.nodes) ? raw.nodes : []).slice(0, 12).entries()) {
    total += 1
    const label = clip(item?.label, 100)
    const detail = clip(item?.detail, 320)
    const proposedId = String(item?.id || '')
    const id = /^[A-Za-z0-9_-]{1,40}$/.test(proposedId) ? proposedId : 'n' + (index + 1)
    if (!label || ids.has(id)) {
      dropped += 1
      continue
    }
    const jobId = String(item?.source?.jobId || '')
    const blockId = String(item?.source?.blockId || '')
    const quote = clip(item?.source?.quote, 220)
    const paper = papers.get(jobId)
    const block = paper?.blocks.get(blockId)
    const quoteKey = numericKey(quote).toLowerCase()
    const grounded =
      Boolean(block && quoteKey) &&
      numericKey([block.section, block.text].filter(Boolean).join(' ')).toLowerCase().includes(quoteKey)
    if (item?.source && !grounded) invalidAnchors += 1
    if (!grounded && /\d/.test(label + ' ' + detail)) {
      dropped += 1
      continue
    }
    const kind = CONCEPT_NODE_KINDS.has(item?.kind) ? item.kind : grounded ? 'evidence' : 'synthesis'
    ids.add(id)
    nodes.push({
      id,
      label,
      detail,
      kind,
      grounded,
      origin: grounded ? 'paper' : 'synthesis',
      ...(grounded
        ? {
            jobId,
            blockId,
            quote,
            page: block.page,
            section: block.section,
            paperTitle: clip(paper?.digest?.title, 120),
          }
        : {}),
    })
  }
  const edges = []
  let invalidEdges = 0
  for (const edge of (Array.isArray(raw?.edges) ? raw.edges : []).slice(0, 24)) {
    const from = String(edge?.from || '')
    const to = String(edge?.to || '')
    if (!ids.has(from) || !ids.has(to) || from === to) {
      invalidEdges += 1
      continue
    }
    edges.push({ from, to, label: clip(edge?.label, 60) })
  }
  if (dropped > 0) warnings.push(dropped + ' 个节点为空、重复或含无出处数字，已丢弃')
  if (invalidAnchors > 0) warnings.push(invalidAnchors + ' 个节点锚点无法在原文中核对，已标为模型归纳')
  if (invalidEdges > 0) warnings.push(invalidEdges + ' 条关系因节点不存在已忽略')
  if (nodes.length === 0) warnings.push('没有可渲染的概念节点；请缩小问题后重试')
  return {
    kind: 'concept',
    title: clip(raw?.title, 120) || '论文概念图',
    summary: clip(raw?.summary, 300),
    nodes,
    edges,
    warnings,
    stats: {
      total,
      kept: nodes.length,
      dropped,
      grounded: nodes.filter((node) => node.grounded).length,
      synthesis: nodes.filter((node) => !node.grounded).length,
    },
  }
}

/**
 * 模型工具：按 jobIds 取回 1–3 篇精简档案。
 * @param {{readDigests: Function}} options - 受约束的读取器。
 * @returns {object} 工具定义。
 */
export function createReadPapersTool({ readDigests }) {
  return {
    name: 'doraemon_read_papers',
    description:
      '读取大肥鱼多篇对照包中的论文精简档案（1–3 篇）：标题、摘要、章节、每节关键段与 blockId。用户消息出现「多篇对照」或「引用对照」并给出 jobId 时，先调用本工具，再按消息里的对照规则回答。档案是确定性抽取，不含全文；需要更细的原文时用返回的 blockId 生成 dsh-resource://doraemon-paper/<jobId>/<blockId> 链接。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['jobIds'],
      properties: {
        jobIds: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          items: { type: 'string', description: '作业 id，形如 0141f2b1-e958-…' },
          description: '要对照的论文作业 id，顺序与消息里的 P1/P2/P3 一致。',
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      presentationMeta: (_args, value) => ({
        count: Array.isArray(value?.digests) ? value.digests.length : 0,
        titles: (Array.isArray(value?.digests) ? value.digests : []).map((digest) => digest.title),
      }),
    },
    async execute(args) {
      const digests = await readDigests(args?.jobIds)
      return { digests }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '读取论文对照档案',
      kind: 'read',
      rawInput: '论文 ' + (Array.isArray(args?.jobIds) ? args.jobIds.length : 0) + ' 篇',
    }),
    presentResult: (_args, result) => {
      const titles = Array.isArray(result?.meta?.titles) ? result.meta.titles : []
      return {
        card: 'generic',
        title: '已读取 ' + (Number(result?.meta?.count) || 0) + ' 篇对照档案',
        content: titles.length > 0 ? [{ type: 'text', text: titles.map((title) => '· ' + title).join('\n') }] : undefined,
      }
    },
    isConcurrencySafe: () => true,
  }
}

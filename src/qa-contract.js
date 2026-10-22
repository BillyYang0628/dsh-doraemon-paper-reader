// B6 批注问答契约：意图识别、回答策略与确定性质量探针。
//
// 这里不调用模型，也不读取文件。批注消息、模型工具说明和对照工作台
// 共用本模块，避免三处提示词慢慢跑偏。

export const QA_CONTRACT_VERSION = 1

export const QA_INTENTS = {
  SUMMARY: 'summary',
  TERM: 'term',
  METHOD: 'method',
  VISUAL: 'visual',
  SECTION_ROLE: 'section-role',
  INSPIRATION: 'inspiration',
  CRITIQUE: 'critique',
  MIXED: 'mixed',
}

export const EVIDENCE_MODES = {
  ALLOW_EXTERNAL: 'allow-external',
  PAPER_ONLY: 'paper-only',
}

export const ANSWER_MODES = {
  DEFAULT: 'default',
  RESEARCH: 'research',
  INSPIRATION: 'inspiration',
  MIXED: 'mixed',
}

const EVIDENCE_MODE_LABELS = {
  [EVIDENCE_MODES.ALLOW_EXTERNAL]: '默认精读：可补充外部背景，但必须标明外部来源；没有检索能力时明确未核验',
  [EVIDENCE_MODES.PAPER_ONLY]: '只根据论文原文，不使用外部资料，也不把模型常识写成论文结论',
}

const ANSWER_SHAPES = {
  [QA_INTENTS.SUMMARY]: [
    '先给这段的核心结论',
    '再解释关键概念、证据或论证链',
    '补一句它与全文前后文的关系',
    '最后给一个更短、可复述的总结',
  ],
  [QA_INTENTS.TERM]: [
    '先直接说明它是什么',
    '再解释它在本文语境中的含义',
    '说明作者为什么需要它',
    '必要时给一个贴近本文的类比',
  ],
  [QA_INTENTS.METHOD]: [
    '先用一句话说明这段方法解决什么问题',
    '按输入、处理、输出或阶段重建流程',
    '解释每一步为什么存在',
    '最后说明它和实验、结果或全文论证的关系',
  ],
  [QA_INTENTS.VISUAL]: [
    '先给图表最重要的结论',
    '再指出对应行、列、数值或图元',
    '解释这些证据支持什么判断',
    '最后提醒阅读时不能外推的边界',
  ],
  [QA_INTENTS.SECTION_ROLE]: [
    '先说这一段在论文中的功能',
    '再说明它承接了前文什么内容',
    '说明它如何推动后文问题、方法或结论',
    '必要时指出删掉它会损失哪条信息',
  ],
  [QA_INTENTS.INSPIRATION]: [
    '先准确解释原文事实，不把创意混成作者结论',
    '再给 1–3 个可验证的迁移点或创意',
    '每个创意说明所需数据、实验或资源',
    '最后给风险；没有查新时明确写“未查新”',
  ],
  [QA_INTENTS.CRITIQUE]: [
    '先给总体判断',
    '再按研究设计、证据、实验或论证逐项评价',
    '区分作者已承认的局限与模型新增判断',
    '最后给最值得优先补强的一点',
  ],
  [QA_INTENTS.MIXED]: [
    '先逐条回答用户问题',
    '需要时按论文或批注分组',
    '最后再做跨条目归纳',
  ],
}

/** 规范化可选回答策略；旧批注包没有该字段时使用安全默认值。 */
export function normalizeAnswerPolicy(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    version: QA_CONTRACT_VERSION,
    evidenceMode:
      source.evidenceMode === EVIDENCE_MODES.PAPER_ONLY
        ? EVIDENCE_MODES.PAPER_ONLY
        : EVIDENCE_MODES.ALLOW_EXTERNAL,
    critique: 'on-request',
    mode: [ANSWER_MODES.RESEARCH, ANSWER_MODES.INSPIRATION, ANSWER_MODES.MIXED].includes(source.mode)
      ? source.mode
      : ANSWER_MODES.DEFAULT,
    researchDirection: clean(source.researchDirection).slice(0, 2000),
  }
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function questionText(question, annotations = []) {
  const items = Array.isArray(annotations) ? annotations : []
  return [
    question,
    ...items.map((item) => item?.question),
  ]
    .map(clean)
    .filter(Boolean)
    .join('\n')
}

function classifyOneQuestion(text) {
  const value = clean(text)
  if (!value) return QA_INTENTS.SUMMARY
  if (/批判|批评|局限|不足|缺陷|风险|是否充分|critique|limitation/i.test(value)) {
    return QA_INTENTS.CRITIQUE
  }
  if (/灵感|点子|创意|创新|后续研究|未来工作|可以怎么改进|研究机会|idea/i.test(value)) {
    return QA_INTENTS.INSPIRATION
  }
  if (/方法|流程|输入|输出|机制|结构|怎么实现|pipeline|method/i.test(value)) {
    return QA_INTENTS.METHOD
  }
  if (/表格|这个表|这张表|该表|表中|表里|图表|读数|数值|figure|table|accuracy|准确率/i.test(value)) {
    return QA_INTENTS.VISUAL
  }
  if (/作用|为什么放在|全文|前后文|上下文|这一段.*关系|这一节|section role/i.test(value)) {
    return QA_INTENTS.SECTION_ROLE
  }
  if (/是什么|什么意思|含义|术语|概念|缩写|define|what is/i.test(value)) {
    return QA_INTENTS.TERM
  }
  return QA_INTENTS.SUMMARY
}

/** 根据整体问题与各条批注识别回答意图，多意图时显式标记 mixed。 */
export function classifyQuestionIntent(question, annotations = []) {
  const values = [
    clean(question),
    ...(Array.isArray(annotations) ? annotations.map((item) => clean(item?.question)) : []),
  ].filter(Boolean)
  if (values.length === 0) return QA_INTENTS.SUMMARY
  const intents = [...new Set(values.map(classifyOneQuestion))].filter(
    (intent) => intent !== QA_INTENTS.SUMMARY,
  )
  if (intents.length === 0) return QA_INTENTS.SUMMARY
  if (intents.length === 1) return intents[0]
  if (intents.includes(QA_INTENTS.CRITIQUE) && values.length === 1) return QA_INTENTS.CRITIQUE
  return QA_INTENTS.MIXED
}

function hasPaperOnlyRequest(packet) {
  return /只根据原文|仅根据原文|不要使用外部|不用外部|不要联网|原文以外|paper[- ]only/i.test(
    questionText(packet?.question, packet?.annotations),
  )
}

/** 生成供提示词、工具说明和评估共用的回答策略。 */
export function buildAnswerPolicy(packet = {}) {
  const configured = normalizeAnswerPolicy(packet?.answerPolicy)
  const intent = classifyQuestionIntent(packet?.question, packet?.annotations)
  const evidenceMode = hasPaperOnlyRequest(packet)
    ? EVIDENCE_MODES.PAPER_ONLY
    : configured.evidenceMode
  return {
    version: QA_CONTRACT_VERSION,
    intent,
    mode: configured.mode,
    modeLabel:
      configured.mode === ANSWER_MODES.RESEARCH
        ? '研究模式'
        : configured.mode === ANSWER_MODES.INSPIRATION
          ? '灵感模式'
          : configured.mode === ANSWER_MODES.MIXED
            ? '混合模式'
          : '默认精读',
    researchDirection: configured.researchDirection,
    modeReady:
      configured.mode !== ANSWER_MODES.RESEARCH || Boolean(configured.researchDirection),
    evidenceMode,
    evidenceModeLabel: EVIDENCE_MODE_LABELS[evidenceMode],
    critiqueAllowed: [QA_INTENTS.CRITIQUE, QA_INTENTS.INSPIRATION].includes(intent),
    answerShape: ANSWER_SHAPES[intent] || ANSWER_SHAPES[QA_INTENTS.SUMMARY],
    mode: configured.mode,
  }
}

function coreContractLines(policy) {
  return [
    '第一段先直接回答用户真正问的问题；没有具体问题时，做理解后的讲解与总结。',
    '主体先解释论文中的概念、证据、机制、因果和上下文；默认目标是帮助精读，不是审稿。',
    policy.critiqueAllowed
      ? '用户已允许批判：批判要有证据，并与论文事实分开。'
      : '用户未明确要求时，批判只放在末尾“局限/需注意”，通常 1–3 点，不能抢主体。',
    '长回答必须经过理解后重组，使用结论—证据/机制—关系—总结等结构，禁止逐句同义改写原文。',
    '保留必要的短引，但原文引述不能成为回答主体；引用原文时保留页码或 blockId。',
    policy.evidenceMode === EVIDENCE_MODES.PAPER_ONLY
      ? '证据范围：只使用论文原文；不引入外部事实，不把模型常识写成作者结论。'
      : '证据范围：默认精读；可补充外部背景，但必须标为外部资料并给来源。没有联网或检索失败时，明确写“未做外部核验”。',
    '区分论文原文、外部资料和模型分析；不确定就写不确定，不补造实验、数字或结论。',
  ]
}

function modeContractLines(policy) {
  if (policy.mode === ANSWER_MODES.RESEARCH) {
    return [
      '研究模式：前段仍先回答用户问题并保持默认精读事实不变。',
      '末尾增加“与你的研究方向”小节，分析可迁移的方法、实验、数据、指标、工具、对照或组合方案。',
      '研究方向：' + (policy.researchDirection || '未填写'),
      '区分“论文明确支持”“模型推导”“相关但未验证”；关联弱时直接说明。',
    ]
  }
  if (policy.mode === ANSWER_MODES.INSPIRATION) {
    return [
      '灵感模式：先准确解释原文，再给 1–3 个可验证创意，不把模型创意混成作者贡献。',
      '每个创意包含原文 blockId/短引、可迁移技术、数据或实验需求、风险或反例。',
      '当前会话提供 doraemon_search_novelty 时，必须优先调用它；先提取 3–6 个检索查询并核对真实候选。',
      '未调用检索或检索失败时明确写“未查新”，不得声称绝对新颖。',
    ]
  }
  if (policy.mode === ANSWER_MODES.MIXED) {
    return [
      '混合模式：逐条读取 annotations[].answerMode；研究模式批注增加研究方向末端分析，灵感模式批注增加可验证创意与查新状态。',
      '先逐条回答，再做必要的跨条目归纳；不要把某条批注的模式套到所有批注。',
    ]
  }
  return []
}

/** 用户消息里的紧凑契约，避免把完整评分规则塞进聊天气泡。 */
export function buildAnnotationContract(packet = {}, { compact = false } = {}) {
  const policy = buildAnswerPolicy(packet)
  if (compact) {
    return [
      '回答契约 B6 v' +
        QA_CONTRACT_VERSION +
        ' · ' +
        policy.intent +
        ' · ' +
        (policy.evidenceMode === EVIDENCE_MODES.PAPER_ONLY ? '只根据原文' : '默认精读'),
      '・第一段直接回答；没有具体问题时，做理解后的讲解与总结。',
      policy.critiqueAllowed
        ? '・批判要有证据，并与论文事实分开。'
        : '・不默认审稿；批判只放末尾“局限/需注意”，不能抢主体。',
      '・长回答按结论—证据/机制—关系—总结重组，不逐句改写原文。',
      policy.evidenceMode === EVIDENCE_MODES.PAPER_ONLY
        ? '・只使用论文原文，不补外部事实。'
        : '・外部资料必须标来源；无联网能力时明确写“未做外部核验”。',
      '・建议结构：' + policy.answerShape.slice(0, 3).join(' → '),
      ...modeContractLines(policy).map((line) => '・' + line),
    ].join('\n')
  }
  const shape = policy.answerShape.slice(0, 4).map((item) => '→ ' + item)
  return [
    '回答契约 B6 v' + QA_CONTRACT_VERSION + '（' + policy.intent + '）',
    ...coreContractLines(policy).map((line) => '・' + line),
    ...modeContractLines(policy).map((line) => '・' + line),
    '・本题建议结构：',
    ...shape.map((line) => '　' + line),
  ].join('\n')
}

/** 工具描述使用的完整策略，不直接显示在用户气泡里。 */
export function buildAnnotationToolPolicy() {
  return [
    '回答任何批注前遵守 B6 契约：',
    ...coreContractLines({
      critiqueAllowed: false,
      evidenceMode: EVIDENCE_MODES.ALLOW_EXTERNAL,
    }).map((line, index) => index + 1 + '. ' + line),
    '若 answerPolicy.mode=research，末尾增加“与你的研究方向”；若 researchDirection 为空，指出无法进行方向关联。',
    '若 answerPolicy.mode=inspiration，给出有原文锚点和风险的可验证创意；当前会话有 doraemon_search_novelty 时必须调用，无检索时明确“未查新”。',
    '如果输入包含 answerPolicy 或 qaContract，以更具体的那一项为准。',
  ].join('\n')
}

/** 对照工作台等纯原文问答可复用同一核心契约。 */
export function buildQaSystemContract({
  question = '',
  annotations = [],
  evidenceMode = EVIDENCE_MODES.PAPER_ONLY,
  mode = ANSWER_MODES.DEFAULT,
  researchDirection = '',
} = {}) {
  const intent = classifyQuestionIntent(question, annotations)
  const policy = {
    intent,
    evidenceMode,
    mode,
    researchDirection,
    critiqueAllowed: [QA_INTENTS.CRITIQUE, QA_INTENTS.INSPIRATION].includes(intent),
  }
  return [
    'B6 回答契约：',
    ...coreContractLines(policy).map((line, index) => index + 1 + '. ' + line),
    ...modeContractLines(policy).map((line, index) => '模式 ' + (index + 1) + '. ' + line),
    '建议结构：' + ANSWER_SHAPES[intent].join('；'),
  ].join('\n')
}

function normalizedWords(value) {
  return (
    clean(value)
      .toLowerCase()
      .match(/[a-z0-9]+|[\u4e00-\u9fff]/g) || []
  )
}

function copyMetrics(sourceText, answerText) {
  const source = normalizedWords(sourceText).slice(0, 6000)
  const answer = normalizedWords(answerText).slice(0, 6000)
  const seed = 6
  if (source.length < seed || answer.length < seed) {
    return { longestTokens: 0, longestChars: 0, copiedRatio: 0 }
  }
  const starts = new Map()
  for (let index = 0; index <= source.length - seed; index += 1) {
    const key = source.slice(index, index + seed).join(' ')
    const values = starts.get(key) || []
    if (values.length < 8) values.push(index)
    starts.set(key, values)
  }
  const covered = new Set()
  let longestTokens = 0
  let longestStart = -1
  let longestEnd = -1
  for (let index = 0; index <= answer.length - seed; index += 1) {
    const key = answer.slice(index, index + seed).join(' ')
    for (const sourceStart of starts.get(key) || []) {
      let answerStart = index
      let sourceCursor = sourceStart
      while (
        answerStart > 0 &&
        sourceCursor > 0 &&
        answer[answerStart - 1] === source[sourceCursor - 1]
      ) {
        answerStart -= 1
        sourceCursor -= 1
      }
      let answerEnd = index + seed
      sourceCursor = sourceStart + seed
      while (
        answerEnd < answer.length &&
        sourceCursor < source.length &&
        answer[answerEnd] === source[sourceCursor]
      ) {
        answerEnd += 1
        sourceCursor += 1
      }
      for (let cursor = answerStart; cursor < answerEnd; cursor += 1) covered.add(cursor)
      if (answerEnd - answerStart > longestTokens) {
        longestTokens = answerEnd - answerStart
        longestStart = answerStart
        longestEnd = answerEnd
      }
    }
  }
  const longestChars =
    longestStart >= 0
      ? answer.slice(longestStart, longestEnd).join(' ').length
      : 0
  return {
    longestTokens,
    longestChars,
    copiedRatio: answer.length ? covered.size / answer.length : 0,
  }
}

function firstSubstantiveParagraph(answer) {
  for (const rawLine of String(answer || '').split(/\r?\n/)) {
    if (/^\s*#{1,6}\s+/.test(rawLine)) continue
    const line = rawLine.trim()
    if (!line) continue
    if (/^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line)) continue
    if (/^\*\*[^*]{1,72}\*\*[:：]?$/.test(line)) continue
    if (line.length <= 12 && !/[。.!?！？]/.test(line)) continue
    return line
  }
  return ''
}

function answerTokens(value) {
  return [
    ...new Set(
      normalizedWords(value).filter(
        (token) => token.length > 1 || /[\u4e00-\u9fff]/.test(token),
      ),
    ),
  ];
}

/**
 * 确定性质量探针。只检查结构与明显退化，不宣称自动判断语义正确。
 */
export function assessAnswer(answer, packet = {}, options = {}) {
  const text = String(answer || '').trim()
  const policy = buildAnswerPolicy(packet)
  const sourceText = (Array.isArray(packet?.annotations) ? packet.annotations : [])
    .flatMap((item) => item?.segments || [])
    .map((segment) => segment?.content || segment?.quote || '')
    .join('\n')
  const copy = copyMetrics(sourceText, text)
  const first = firstSubstantiveParagraph(text)
  const question = clean([packet?.question, ...(packet?.annotations || []).map((item) => item?.question)].join(' '))
  const wanted = answerTokens(question)
  const openingWords = new Set(normalizedWords(first))
  const overlap = wanted.length
    ? wanted.filter((token) => openingWords.has(token)).length / wanted.length
    : 0
  const cue =
    policy.intent === QA_INTENTS.METHOD
      ? /输入|处理|输出|机制|流程|步骤|input|process|output/i
      : policy.intent === QA_INTENTS.VISUAL
        ? /表|图|数值|准确率|结果|行|列|table|figure/i
        : /结论|核心|指|是|用于|作用|说明|可以理解为|summary|means/i
  const directOpening =
    first.length >= 18 &&
    (overlap >= 0.08 ||
      cue.test(first) ||
      (policy.mode === ANSWER_MODES.INSPIRATION && policy.intent === QA_INTENTS.INSPIRATION))
  const hasStructure =
    /(?:^|\n)\s*(?:#{1,6}\s+|[-*]\s+|\d+\.\s+|\|.+\|)/m.test(text) ||
    text.split(/\n\s*\n/).filter(Boolean).length >= 2
  const critiqueMatches = [
    ...text.matchAll(/局限|不足(?!以)|缺陷|风险|需要注意|limitation|weakness/gi),
  ]
  const firstCritique = critiqueMatches[0]?.index ?? -1
  const critiqueStartRatio = firstCritique < 0 ? 1 : firstCritique / Math.max(1, text.length)
  const critiqueHeading = text.match(
    /(?:^|\n)(?:#{1,6}\s*)?(?:[一二三四五六七八九十]+[、.]\s*)?(?:局限|需注意|limitations?)(?:\s*\/\s*需注意)?/i,
  )
  const critiqueHeadingRatio =
    critiqueHeading?.index == null
      ? -1
      : critiqueHeading.index / Math.max(1, text.length)
  const critiqueSectionNearEnd = critiqueHeadingRatio >= 0.45
  const unrequestedCritique =
    !policy.critiqueAllowed &&
    firstCritique >= 0 &&
    critiqueStartRatio < 0.55 &&
    !critiqueSectionNearEnd
  const citationPresent =
    /dsh-resource:\/\/doraemon-paper\//.test(text) ||
    /\/doraemon-paper-reader\/api\/open\?/.test(text) ||
    /\bp\.\s*\d+/i.test(text) ||
    /\bblockId\b/i.test(text) ||
    /\bb\d{3,}\b/i.test(text)
  const externalMarker = /外部资料|外部来源|网页检索|网络检索|search result|external source/i.test(text)
  const unverifiedDisclosure = /未做外部核验|未联网|无法外部核验|未进行外部检索|外部检索失败/i.test(text)
  const asksExternal = /联网|检索|外部|网页|web|search/i.test(question)
  const paperOnlyViolation =
    policy.evidenceMode === EVIDENCE_MODES.PAPER_ONLY &&
    /根据外部|网页资料|网络资料|检索结果显示|according to external/i.test(text)
  const modeChecks =
    policy.mode === ANSWER_MODES.RESEARCH
      ? {
          modePolicyReady: policy.modeReady,
          researchTailPresent: /与你的研究方向|研究方向.*(?:关联|启发|可迁移)/.test(text),
          researchLevels:
            /论文明确支持|模型推导|相关但未验证|论文事实|模型分析/.test(text),
        }
      : policy.mode === ANSWER_MODES.INSPIRATION
        ? {
            modePolicyReady: true,
            ideaAnchored: /创意|点子|创新点/.test(text) && /blockId|p\.\s*\d+|原文/.test(text),
            ideaFeasible: /数据|实验|资源/.test(text) && /风险|反例/.test(text),
            noveltyCautious:
              /未查新|高度相似|部分相关|当前检索未发现|不能证明绝对新颖/.test(text),
          }
        : {}
  const verbatimOk = copy.longestChars <= 240 && copy.copiedRatio <= 0.42
  const checks = {
    directOpening,
    reconstructedStructure: hasStructure,
    critiquePlacement: !unrequestedCritique,
    verbatimBounded: verbatimOk,
    citationPresent,
    evidenceBoundary:
      policy.evidenceMode === EVIDENCE_MODES.PAPER_ONLY
        ? !paperOnlyViolation
        : externalMarker
          ? /https?:\/\/|来源[:：]|doi|arxiv/i.test(text)
          : !asksExternal || unverifiedDisclosure,
    externalFallback:
      policy.evidenceMode === EVIDENCE_MODES.PAPER_ONLY ||
      externalMarker ||
      unverifiedDisclosure ||
      !asksExternal,
    ...modeChecks,
  }
  const failed = Object.entries(checks).filter(([, value]) => !value).map(([key]) => key)
  const status = failed.length === 0 ? 'pass' : failed.length <= 2 ? 'partial' : 'fail'
  return {
    version: QA_CONTRACT_VERSION,
    scope: 'deterministic-structure-only',
    status,
    policy,
    metrics: {
      chars: text.length,
      firstParagraphChars: first.length,
      questionOpeningOverlap: Number(overlap.toFixed(3)),
      longestCopiedTokens: copy.longestTokens,
      longestCopiedChars: copy.longestChars,
      copiedRatio: Number(copy.copiedRatio.toFixed(3)),
      critiqueStartRatio: Number(critiqueStartRatio.toFixed(3)),
      critiqueHeadingRatio:
        critiqueHeadingRatio < 0 ? -1 : Number(critiqueHeadingRatio.toFixed(3)),
    },
    checks,
    failed,
    warnings: [
      ...(!hasStructure ? ['没有识别到清晰的结构化重组'] : []),
      ...(!verbatimOk ? ['连续复述原文或原文占比过高'] : []),
      ...(unrequestedCritique ? ['未要求批判时批判出现在回答前部'] : []),
      ...(paperOnlyViolation ? ['只根据原文模式中出现了外部资料表述'] : []),
      ...(checks.modePolicyReady === false ? ['研究模式缺少可用的研究方向'] : []),
      ...(checks.researchTailPresent === false ? ['研究模式缺少末尾研究方向分析'] : []),
      ...(checks.researchLevels === false ? ['研究模式没有区分论文事实、模型推导与未验证关联'] : []),
      ...(checks.ideaAnchored === false ? ['灵感模式创意缺少原文锚点'] : []),
      ...(checks.ideaFeasible === false ? ['灵感模式创意缺少数据/实验需求或风险'] : []),
      ...(checks.noveltyCautious === false ? ['灵感模式没有给出谨慎的查新状态'] : []),
      ...(options.requireCitation && !citationPresent ? ['回答缺少页码、blockId 或回跳链接'] : []),
    ],
  }
}

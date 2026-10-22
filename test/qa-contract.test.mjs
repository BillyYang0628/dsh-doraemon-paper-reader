import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  ANSWER_MODES,
  EVIDENCE_MODES,
  QA_CONTRACT_VERSION,
  QA_INTENTS,
  assessAnswer,
  buildAnnotationContract,
  buildAnswerPolicy,
  buildQaSystemContract,
  classifyQuestionIntent,
  normalizeAnswerPolicy,
} from '../src/qa-contract.js'

function packet(question, evidenceMode = EVIDENCE_MODES.ALLOW_EXTERNAL) {
  return {
    type: 'doraemon-annotations',
    question,
    answerPolicy: { evidenceMode },
    annotations: [
      {
        question,
        segments: [
          {
            quote: 'MobileViT combines convolutional blocks for local features with transformer blocks for global context.',
            content:
              'MobileViT combines convolutional blocks for local features with transformer blocks for global context. The input feature map is unfolded into patches, transformed, folded back, and fused with 1 by 1 convolution.',
            page: 7,
            blockId: 'b0053',
          },
        ],
      },
    ],
  }
}

test('B6 意图识别：术语、方法、图表、段落作用、灵感、批判和无问题总结', () => {
  assert.equal(classifyQuestionIntent('MobileViT 是什么？'), QA_INTENTS.TERM)
  assert.equal(classifyQuestionIntent('这个表最重要的比较结论是什么？'), QA_INTENTS.VISUAL)
  assert.equal(classifyQuestionIntent('把方法按输入处理输出讲清楚'), QA_INTENTS.METHOD)
  assert.equal(classifyQuestionIntent('这一段在全文里起什么作用？'), QA_INTENTS.SECTION_ROLE)
  assert.equal(classifyQuestionIntent('这里有什么值得继续做的点子？'), QA_INTENTS.INSPIRATION)
  assert.equal(classifyQuestionIntent('请批判性评价实验是否充分'), QA_INTENTS.CRITIQUE)
  assert.equal(classifyQuestionIntent(''), QA_INTENTS.SUMMARY)
})

test('B6 策略：只根据原文覆盖 UI 默认值，多问题识别为 mixed', () => {
  const input = packet('')
  input.annotations = [
    { question: '把方法按输入处理输出讲清楚', segments: [{ quote: 'method' }] },
    { question: '请批判性评价实验是否充分', segments: [{ quote: 'experiment' }] },
  ]
  input.answerPolicy.evidenceMode = EVIDENCE_MODES.PAPER_ONLY
  const policy = buildAnswerPolicy(input)
  assert.equal(policy.evidenceMode, EVIDENCE_MODES.PAPER_ONLY)
  assert.equal(policy.intent, QA_INTENTS.MIXED)
  assert.deepEqual(normalizeAnswerPolicy({ evidenceMode: 'bad-value' }), {
    version: QA_CONTRACT_VERSION,
    evidenceMode: EVIDENCE_MODES.ALLOW_EXTERNAL,
    critique: 'on-request',
    mode: 'default',
    researchDirection: '',
  })
})

test('B7 模式策略：研究方向与研究/灵感回答段落进入契约', () => {
  const research = packet('解释这段方法')
  research.answerPolicy.mode = ANSWER_MODES.RESEARCH
  research.answerPolicy.researchDirection = '我正在研究低功耗边缘设备上的轻量视觉模型。'
  const researchPolicy = buildAnswerPolicy(research)
  assert.equal(researchPolicy.mode, ANSWER_MODES.RESEARCH)
  assert.equal(researchPolicy.modeReady, true)
  assert.match(buildAnnotationContract(research), /与你的研究方向/)
  assert.match(buildAnnotationContract(research), /低功耗边缘设备/)

  const inspiration = packet('这段有什么可继续做的点子？')
  inspiration.answerPolicy.mode = ANSWER_MODES.INSPIRATION
  const inspirationContract = buildAnnotationContract(inspiration)
  assert.match(inspirationContract, /doraemon_search_novelty/)
  assert.match(inspirationContract, /未查新/)
})

test('B6 契约：包含直接回答、克制批判、证据边界与意图结构', () => {
  const contract = buildAnnotationContract(packet('把方法按输入处理输出讲清楚'))
  assert.match(contract, /第一段先直接回答/)
  assert.match(contract, /默认目标是帮助精读，不是审稿/)
  assert.match(contract, /禁止逐句同义改写/)
  assert.match(contract, /默认精读/)
  assert.match(contract, /输入、处理、输出/)
  assert.ok(contract.length < 1400)
  assert.match(buildQaSystemContract({ question: '请批判实验是否充分' }), /用户已允许批判/)
})

test('B6 评估器：结构清楚、短引且有回跳的回答通过确定性探针', () => {
  const answer = [
    '**结论先行**',
    '',
    '结论：MobileViT-XXSmall 在该测试集上达到 99.5% 准确率，高于 MobileNetV3-Small 的 97.5%。',
    '',
    '| 维度 | MobileViT | MobileNet |',
    '|---|---|---|',
    '| 准确率 | 99.5% | 97.5% |',
    '',
    '这说明混合局部卷积与全局注意力带来了约 2 个百分点的提升，但比较仍受数据集范围限制。',
    '',
    '局限：这里只比较了一个数据集，不能直接推断所有作物场景。',
    '',
    '[p.11](dsh-resource://doraemon-paper/job/b0097)',
  ].join('\n')
  const result = assessAnswer(answer, packet('这个表最重要的比较结论是什么？'), {
    requireCitation: true,
  })
  assert.equal(result.status, 'pass', JSON.stringify(result, null, 2))
  assert.equal(result.checks.directOpening, true)
  assert.equal(result.checks.reconstructedStructure, true)
  assert.equal(result.checks.citationPresent, true)
})

test('B6 评估器：前部无端批判和连续复述会被标记', () => {
  const source =
    'MobileViT combines convolutional blocks for local features with transformer blocks for global context. The input feature map is unfolded into patches, transformed, folded back, and fused with 1 by 1 convolution.'
  const answer =
    '这个方法的不足是实验不够充分。' +
    source +
    source +
    source
  const result = assessAnswer(answer, packet('解释 MobileViT 是什么'))
  assert.notEqual(result.status, 'pass')
  assert.equal(result.checks.critiquePlacement, false)
  assert.equal(result.checks.verbatimBounded, false)
  assert.match(result.warnings.join('；'), /连续复述|批判/)
})

test('B6 评估器：纯原文模式发现外部资料表述', () => {
  const answer =
    'MobileViT 是混合模型。根据外部资料，这种结构也常用于其他视觉任务。\n\n局限：本文只测试一个数据集。 [p.7](dsh-resource://doraemon-paper/job/b0053)'
  const result = assessAnswer(
    answer,
    packet('只根据原文解释 MobileViT', EVIDENCE_MODES.PAPER_ONLY),
    { requireCitation: true },
  )
  assert.equal(result.checks.evidenceBoundary, false)
  assert.match(result.warnings.join('；'), /外部资料/)
})

test('B7 研究模式：必须有末端方向分析并区分证据层级', () => {
  const input = packet('把方法按输入、处理、输出讲清楚')
  input.answerPolicy.mode = ANSWER_MODES.RESEARCH
  input.answerPolicy.researchDirection = '轻量视觉模型与边缘部署'
  const answer = [
    '结论：MobileViT 通过卷积提取局部特征，再用 Transformer 处理 patch 的全局关系。',
    '',
    '- 输入：卷积后的特征图。',
    '- 处理：unfold → transformer → fold。',
    '- 输出：融合后的二维特征图。',
    '',
    '与你的研究方向：',
    '- 论文明确支持：混合结构兼顾局部与全局特征。',
    '- 模型推导：可尝试迁移到低功耗边缘设备，但相关但未验证。',
    '- 可复用实验：比较不同 patch 划分的能耗与时延。',
    '',
    '[p.7](dsh-resource://doraemon-paper/job/b0053)',
  ].join('\n')
  const result = assessAnswer(answer, input, { requireCitation: true })
  assert.equal(result.status, 'pass', JSON.stringify(result, null, 2))
  assert.equal(result.checks.researchTailPresent, true)
  assert.equal(result.checks.researchLevels, true)
})

test('B7 灵感模式：创意必须有原文锚点、可行性、风险与查新状态', () => {
  const input = packet('这段有什么值得继续做的创意？')
  input.answerPolicy.mode = ANSWER_MODES.INSPIRATION
  const answer = [
    'MobileViT 用卷积提取局部特征，再用 Transformer 建模 patch 关系。',
    '',
    '创意：比较可学习的 patch 划分。',
    '- 原文锚点：p.7 b0053 的 unfold/fold 流程。',
    '- 数据与实验：需要多种作物图像，并测量精度、时延和显存。',
    '- 风险：patch 过大会损失病斑细节。',
    '- 查新：未查新；当前没有调用外部文献检索。',
    '',
    '[p.7](dsh-resource://doraemon-paper/job/b0053)',
  ].join('\n')
  const result = assessAnswer(answer, input, { requireCitation: true })
  assert.equal(result.status, 'pass', JSON.stringify(result, null, 2))
  assert.equal(result.checks.ideaAnchored, true)
  assert.equal(result.checks.ideaFeasible, true)
  assert.equal(result.checks.noveltyCautious, true)
})

test('B7 研究模式：空研究方向不通过模式门禁', () => {
  const input = packet('解释方法')
  input.answerPolicy.mode = ANSWER_MODES.RESEARCH
  const result = assessAnswer(
    '结论：这是方法解释。\n\n- 输入与输出已经说明。\n\n[p.7](dsh-resource://doraemon-paper/job/b0053)',
    input,
    { requireCitation: true },
  )
  assert.equal(result.checks.modePolicyReady, false)
  assert.equal(result.checks.researchTailPresent, false)
})

test('B6/B7 固定问题集：9 个真实段落、必备事实、禁止项与证据策略齐全', async () => {
  const fixture = JSON.parse(
    await readFile(new URL('./fixtures/qa-contract-v1.json', import.meta.url), 'utf8'),
  )
  assert.equal(fixture.version, 3)
  assert.equal(fixture.cases.length, 9)
  assert.equal(new Set(fixture.cases.map((item) => item.id)).size, 9)
  for (const item of fixture.cases) {
    assert.ok(item.source?.text)
    assert.ok(item.source?.blockId)
    assert.ok(Array.isArray(item.mustMention) && item.mustMention.length > 0)
    assert.ok(Array.isArray(item.forbidden))
    assert.ok(['allow-external', 'paper-only'].includes(item.answerPolicy?.evidenceMode))
  }
  assert.deepEqual(
    fixture.cases.filter((item) => item.answerPolicy.evidenceMode === 'paper-only').map((item) => item.id),
    ['paper-only'],
  )
  assert.deepEqual(
    fixture.cases.filter((item) => item.answerPolicy.mode).map((item) => item.id),
    ['research-mode', 'inspiration-mode'],
  )
})

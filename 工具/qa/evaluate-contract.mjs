#!/usr/bin/env node
// B6 批注问答契约评估。
//
// 契约模式会注入 src/qa-contract.js 的规则；legacy 模式保留旧式松散说明，
// 用于同一组问题的前后对比。评估结果只描述固定问题集，不代表通用回答质量。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  EVIDENCE_MODES,
  assessAnswer,
  buildAnnotationContract,
  buildAnswerPolicy,
} from '../../src/qa-contract.js'
import { chatText } from '../../src/llm.js'

const args = process.argv.slice(2)
const options = {
  fixture: 'test/fixtures/qa-contract-v1.json',
  out: '工具/gen/B6-20261022/live-contract',
  mode: 'contract',
  only: '',
  maxCases: 0,
  answers: '',
  ignoreCitation: false,
}
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--fixture') options.fixture = args[++index]
  else if (args[index] === '--out') options.out = args[++index]
  else if (args[index] === '--mode') options.mode = args[++index]
  else if (args[index] === '--case') options.only = args[++index]
  else if (args[index] === '--max-cases') options.maxCases = Number(args[++index])
  else if (args[index] === '--answers') options.answers = args[++index]
  else if (args[index] === '--ignore-citation') options.ignoreCitation = true
  else throw new Error('未知参数：' + args[index])
}

const fixture = JSON.parse(await readFile(path.resolve(options.fixture), 'utf8'))
let cases = Array.isArray(fixture.cases) ? fixture.cases : []
if (options.only) cases = cases.filter((item) => item.id === options.only)
if (options.maxCases > 0) cases = cases.slice(0, options.maxCases)

function packetForCase(item) {
  const source = item.source || {}
  return {
    type: 'doraemon-annotations',
    question: item.prompt,
    answerPolicy: item.answerPolicy || { evidenceMode: EVIDENCE_MODES.ALLOW_EXTERNAL },
    annotations: [
      {
        index: 1,
        jobId: 'b6-eval-job',
        question: item.prompt,
        context: {
          paper: { title: source.paperTitle || '', doi: '', arxiv: '' },
          version: { kind: 'unknown', label: '测试原文' },
          brief: {},
          nearbyAssets: [],
        },
        segments: [
          {
            quote: String(source.text || '').slice(0, 1800),
            content: String(source.text || ''),
            before: '',
            after: '',
            page: Number(source.page) || 0,
            blockId: source.blockId || '',
            section: source.section || '',
            kind: 'text',
            citationUrl:
              'http://127.0.0.1/doraemon-paper-reader/api/open?jobId=b6-eval-job&blockId=' +
              encodeURIComponent(source.blockId || ''),
            citationDeepLink:
              'dsh-resource://doraemon-paper/b6-eval-job/' + (source.blockId || ''),
          },
        ],
      },
    ],
  }
}

function normalize(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ')
}

function semanticCoverage(answer, item) {
  const text = normalize(answer)
  const hits = (item.mustMention || []).filter((needle) => text.includes(normalize(needle)))
  const forbidden = (item.forbidden || []).filter((needle) => text.includes(normalize(needle)))
  return {
    hits,
    forbidden,
    coverage: item.mustMention?.length ? hits.length / item.mustMention.length : 1,
  }
}

async function generate(item) {
  const packet = packetForCase(item)
  const question =
    item.prompt +
    '\n当前环境没有联网工具。若回答涉及外部资料或查新，必须明确说明“未做外部核验/未查新”。'
  let system
  let user
  if (options.mode === 'legacy') {
    system = '你是帮助用户精读论文的助手。请回答用户问题。'
    user = [
      '论文原文：',
      item.source?.text || '',
      '',
      '用户问题：' + question,
      '',
      '回答末尾保留页码。',
    ].join('\n')
  } else {
    system =
      '你是大肥鱼论文精读助手。没有联网工具。完整批注包由下一条用户输入提供。\n' +
      buildAnnotationContract(packet)
    user = [
      '请回答下面的批注。',
      '',
      '完整批注包：',
      JSON.stringify(packet, null, 2),
      '',
      '输出中文 Markdown，不要输出工具调用或 JSON。',
    ].join('\n')
  }
  return chatText({
    system,
    user,
    maxTokens: 1500,
    timeoutMs: 120000,
  })
}

let suppliedAnswers = null
if (options.answers) {
  const payload = JSON.parse(await readFile(path.resolve(options.answers), 'utf8'))
  suppliedAnswers = Array.isArray(payload)
    ? new Map(payload.map((item) => [item.id, item.answer || '']))
    : new Map(Object.entries(payload))
}

const results = []
for (let index = 0; index < cases.length; index += 1) {
  const item = cases[index]
  const packet = packetForCase(item)
  const answer = suppliedAnswers
    ? String(suppliedAnswers.get(item.id) || '')
    : await generate(item)
  const requireCitation = !options.ignoreCitation && item.requireCitation !== false
  const probe = assessAnswer(answer, packet, { requireCitation })
  const semantic = semanticCoverage(answer, item)
  const webUnverified =
    !item.webSearchExpected ||
    /未查新|未做外部核验|未联网|无法外部核验|未进行外部检索|external (?:search )?unavailable/i.test(
      answer,
    )
  const failed =
    probe.status === 'fail' ||
    semantic.forbidden.length > 0 ||
    (requireCitation && !probe.checks.citationPresent)
  const partial =
    !failed &&
    (probe.status === 'partial' || semantic.coverage < 0.75 || !webUnverified)
  const status = failed ? 'fail' : partial ? 'partial' : 'pass'
  results.push({
    id: item.id,
    policy: buildAnswerPolicy(packet),
    status,
    answer,
    probe,
    semantic,
    webUnverified,
  })
  console.error(`[b6-eval] ${index + 1}/${cases.length} ${item.id} ${status}`)
}

const summary = {
  generatedAt: new Date().toISOString(),
  mode: options.mode,
  scope:
    '固定批注问答问题集的回归结果；确定性探针只检查结构与明显退化，语义覆盖仍需人工复核。',
  cases: results.length,
  pass: results.filter((item) => item.status === 'pass').length,
  partial: results.filter((item) => item.status === 'partial').length,
  fail: results.filter((item) => item.status === 'fail').length,
  results,
}

const outputDir = path.resolve(options.out)
await mkdir(outputDir, { recursive: true })
await writeFile(path.join(outputDir, 'report.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8')
await writeFile(
  path.join(outputDir, 'answers.md'),
  results
    .map(
      (item) =>
        '# ' +
        item.id +
        '\n\n状态：' +
        item.status +
        '\n\n' +
        item.answer +
        '\n',
    )
    .join('\n---\n\n'),
  'utf8',
)
console.log(JSON.stringify({ out: outputDir, ...summary, results: undefined }, null, 2))
process.exitCode = summary.fail > 0 ? 1 : 0

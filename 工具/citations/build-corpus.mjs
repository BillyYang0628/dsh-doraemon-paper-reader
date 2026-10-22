#!/usr/bin/env node
// 从本地 MirrorDoc 自动抽取真实参考文献，生成分层回归种子。
//
// 这不是“全球准确率数据集”：DOI/arXiv 标签来自参考文献标识符，
// 纯标题样本的标签来自解析后的参考文献文本，均需在失败后持续人工复核。

import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { buildCitationIndex, extractReferenceFields } from '../../src/citations.js'
import { buildLookupQueries } from '../../src/lookup.js'

const args = process.argv.slice(2)
const options = {
  jobsRoot: 'D:\\DSH\\home\\doraemon-paper-reader\\jobs',
  out: 'test/fixtures/citation-retrieval-v1.json',
  failures: '',
  max: 60,
}
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--jobs') options.jobsRoot = args[++index]
  else if (args[index] === '--out') options.out = args[++index]
  else if (args[index] === '--failures') options.failures = args[++index]
  else if (args[index] === '--max') options.max = Number(args[++index])
  else throw new Error('未知参数：' + args[index])
}

function titleKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function stableIndex(value, length) {
  if (length <= 1) return 0
  const digest = createHash('sha256').update(String(value)).digest()
  return digest[0] % length
}

function chooseQuery(caseId, fields) {
  const queries = buildLookupQueries({
    title: fields.title,
    authors: fields.authors,
    venue: fields.venue,
    year: fields.year,
    query: fields.query,
  }).filter((entry) => entry.kind !== 'full')
  if (queries.length === 0) return null
  return queries[stableIndex(caseId, queries.length)]
}

function plausibleTitle(title) {
  const text = String(title ?? '').trim()
  if (text.length < 12 || text.length > 320) return false
  if (text.split(/\s+/).length < 3) return false
  if (
    /^(?:in proceedings|in packaging|in applied|proceedings of|standard\b|american society|international organization)\b/i.test(
      text,
    )
  ) {
    return false
  }
  if (
    /(?:Eds\.;|: Kogan Page|: Springer|: Woodhead|: CRC Press|: Wiley|: Elsevier|: IEEE Press|USA,?$|UK,?$)/i.test(
      text,
    )
  ) {
    return false
  }
  if (/[;,]\s*$/.test(text)) return false
  return /[A-Za-z]{4}/.test(text)
}

const jobsRoot = path.resolve(options.jobsRoot)
const entries = await readdir(jobsRoot, { withFileTypes: true }).catch(() => [])
const buckets = {
  'identifier-reference': [],
  'arxiv-reference': [],
  'title-only-reference': [],
}
const seen = new Set()

for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  const dir = path.join(jobsRoot, entry.name)
  let doc
  try {
    doc = JSON.parse(await readFile(path.join(dir, 'mirrordoc.json'), 'utf8'))
  } catch {
    continue
  }
  const blocks = Array.isArray(doc?.blocks) ? doc.blocks : []
  const index = buildCitationIndex(blocks)
  const indexedReferences = new Map(index.references.map((reference) => [reference.blockId, reference]))
  const blockById = new Map(blocks.map((block) => [block.id, block]))
  const firstCitingBlock = new Map()
  for (const [blockId, spans] of Object.entries(index.byBlock || {})) {
    for (const span of spans) {
      for (const number of span.numbers || []) {
        if (!firstCitingBlock.has(number)) firstCitingBlock.set(number, blockId)
      }
    }
  }
  const referenceBlocks = blocks.filter((block) => block?.type === 'reference')
  for (const block of referenceBlocks) {
    const reference =
      indexedReferences.get(block.id) || {
        number: 0,
        blockId: block.id || '',
        page: Number(block.page) || 0,
        text: String(block.text || ''),
      }
    const fields = extractReferenceFields(reference.text)
    const strongIdentifier = Boolean(fields.doi || fields.arxiv)
    if (!strongIdentifier && !plausibleTitle(fields.title)) continue
    if (strongIdentifier && !fields.title) continue
    const gold = {
      doi: fields.doi || '',
      arxiv: fields.arxiv || '',
      title: fields.title,
    }
    const key = gold.doi
      ? 'doi:' + gold.doi.toLowerCase()
      : gold.arxiv
        ? 'arxiv:' + gold.arxiv.toLowerCase()
        : 'title:' + titleKey(gold.title)
    if (seen.has(key)) continue
    seen.add(key)
    const citingId = reference.number ? firstCitingBlock.get(reference.number) || '' : ''
    const citingBlock = blockById.get(citingId)
    const caseId =
      path.basename(dir) +
      ':' +
      (reference.number || 'noid') +
      ':' +
      createHash('sha1').update(key).digest('hex').slice(0, 8)
    const query = gold.doi
      ? { kind: 'doi-exact', text: gold.doi }
      : gold.arxiv && stableIndex(caseId + ':exact', 2) === 0
        ? { kind: 'arxiv-exact', text: gold.arxiv }
        : chooseQuery(caseId, fields)
    if (!query) continue
    const stratum = gold.doi
      ? 'identifier-reference'
      : gold.arxiv
        ? 'arxiv-reference'
        : 'title-only-reference'
    buckets[stratum].push({
      id: caseId,
      stratum,
      queryKind: query.kind,
      query: { kind: query.kind, text: query.text },
      gold,
      labelBasis: gold.doi ? 'reference-doi' : gold.arxiv ? 'reference-arxiv' : 'reference-text-title',
      reviewStatus: gold.doi || gold.arxiv ? 'identifier-verified' : 'auto-needs-review',
      source: {
        paperTitle: doc?.meta?.title || '',
        page: reference.page,
        referenceNumber: reference.number || 0,
        referenceText: reference.text,
        parsedFields: {
          title: fields.title,
          authors: fields.authors,
          venue: fields.venue,
          year: fields.year,
        },
      },
      citationContext: String(citingBlock?.text || '').slice(0, 900),
    })
  }
}

const maxCases = Math.max(1, options.max)
const quotas = {
  'identifier-reference': Math.min(buckets['identifier-reference'].length, Math.min(20, Math.round(maxCases * 0.25))),
  'arxiv-reference': Math.min(buckets['arxiv-reference'].length, Math.min(30, Math.round(maxCases * 0.5))),
}
const selected = []
for (const stratum of ['identifier-reference', 'arxiv-reference', 'title-only-reference']) {
  const quota =
    stratum === 'title-only-reference'
      ? maxCases - selected.length
      : quotas[stratum] || 0
  selected.push(...buckets[stratum].slice(0, Math.max(0, quota)))
}
for (const stratum of ['identifier-reference', 'arxiv-reference', 'title-only-reference']) {
  if (selected.length >= maxCases) break
  const already = new Set(selected.map((item) => item.id))
  selected.push(
    ...buckets[stratum]
      .filter((item) => !already.has(item.id))
      .slice(0, maxCases - selected.length),
  )
}
const autoCases = selected.slice(0, maxCases)
let failureCases = []
if (options.failures) {
  try {
    const parsed = JSON.parse(await readFile(path.resolve(options.failures), 'utf8'))
    failureCases = (Array.isArray(parsed) ? parsed : parsed?.cases || []).filter(
      (item) =>
        item?.gold &&
        item?.query?.text &&
        item.reviewStatus !== 'discarded' &&
        item.reviewStatus !== 'fixed',
    )
  } catch {
    failureCases = []
  }
}
const deduped = new Map()
for (const item of [...failureCases, ...autoCases]) {
  if (!item?.id || deduped.has(item.id)) continue
  deduped.set(item.id, {
    ...item,
    reviewStatus: item.reviewStatus || 'needs-review',
  })
}
const cases = [...deduped.values()].slice(0, Math.max(maxCases, failureCases.length))

const payload = {
  version: 1,
  generatedAt: new Date().toISOString(),
  scope:
    '自动从本地真实论文参考文献抽取的分层回归种子；只用于本项目回归，不代表全球检索准确率。',
  limitations: [
    'DOI/arXiv 标签可直接核对；title-only 标签来自参考文献解析，需在失败复盘中人工确认。',
    '本文件用于分片指标和失败吸收，不允许用总体均值替代分片结果。',
    '自动种子不是全球学术检索准确率证明；新增真实失败案例必须持续并入并按 stratum/queryKind 分片报告。',
    '通过 --failures 合并的真实失败优先保留，不得为了总体均值删除困难样本。',
  ],
  cases,
}
await writeFile(path.resolve(options.out), JSON.stringify(payload, null, 2) + '\n', 'utf8')
console.log(
  JSON.stringify(
    {
      out: path.resolve(options.out),
      cases: cases.length,
      byStratum: Object.fromEntries(
        [...new Set(cases.map((item) => item.stratum))].map((name) => [
          name,
          cases.filter((item) => item.stratum === name).length,
        ]),
      ),
      byQueryKind: Object.fromEntries(
        [...new Set(cases.map((item) => item.queryKind))].map((name) => [
          name,
          cases.filter((item) => item.queryKind === name).length,
        ]),
      ),
    },
    null,
    2,
  ),
)

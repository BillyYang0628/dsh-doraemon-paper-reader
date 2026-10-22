// 候选检索的离线回归指标。
//
// 这里的统计只描述当前回归集，不代表全球学术检索准确率。正式运行时按
// stratum / queryKind 分片，避免一个容易的标题查询把困难样本掩盖掉。

function normalized(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, '')
    .replace(/^doi:\s*/, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function candidateValue(candidate, kind) {
  if (kind === 'doi') return normalized(candidate?.doi)
  if (kind === 'arxiv') return normalized(candidate?.arxiv)
  return normalized(candidate?.title)
}

function goldKeys(gold = {}) {
  return [
    gold.doi ? { kind: 'doi', value: normalized(gold.doi) } : null,
    gold.arxiv ? { kind: 'arxiv', value: normalized(gold.arxiv) } : null,
    gold.title ? { kind: 'title', value: normalized(gold.title) } : null,
  ].filter(Boolean)
}

/** 返回目标论文在候选列表中的一基位置；0 表示未召回。 */
export function relevantRank(caseResult = {}) {
  const keys = goldKeys(caseResult.gold || {})
  if (keys.length === 0) return 0
  const candidates = Array.isArray(caseResult.candidates) ? caseResult.candidates : []
  for (let index = 0; index < candidates.length; index += 1) {
    if (
      keys.some(
        (key) =>
          candidateValue(candidates[index], key.kind) &&
          candidateValue(candidates[index], key.kind) === key.value,
      )
    ) {
      return index + 1
    }
  }
  return 0
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0
}

function pct(value) {
  return Math.round(value * 1000) / 10
}

function candidateIdentity(candidate) {
  if (normalized(candidate?.doi)) return 'doi:' + normalized(candidate.doi)
  if (normalized(candidate?.arxiv)) return 'arxiv:' + normalized(candidate.arxiv)
  return 'title:' + normalized(candidate?.title)
}

function summarizeCases(cases) {
  let top1 = 0
  let top3 = 0
  let recall5 = 0
  let mrr = 0
  let noResult = 0
  let duplicateCases = 0
  let multiRouteMergeCases = 0
  let routeFailureCases = 0
  let serviceUnavailableCases = 0
  for (const item of cases) {
    const rank = relevantRank(item)
    if (rank === 1) top1 += 1
    if (rank > 0 && rank <= 3) top3 += 1
    if (rank > 0 && rank <= 5) recall5 += 1
    if (rank > 0) mrr += 1 / rank
    if ((item.candidates || []).length === 0) noResult += 1
    const candidates = Array.isArray(item.candidates) ? item.candidates : []
    const identities = candidates.map(candidateIdentity).filter((value) => value !== 'title:')
    if (identities.length !== new Set(identities).size) {
      duplicateCases += 1
    }
    if (Number(item.retrieval?.duplicateCount || item.duplicateCount || 0) > 0) {
      multiRouteMergeCases += 1
    }
    const routes = Array.isArray(item.retrieval?.routes) ? item.retrieval.routes : []
    const failedRoutes = routes.filter((route) => route?.status === 'failed')
    if (failedRoutes.length > 0) routeFailureCases += 1
    if (routes.length > 0 && failedRoutes.length === routes.length) {
      serviceUnavailableCases += 1
    }
  }
  const total = cases.length
  return {
    cases: total,
    top1: pct(ratio(top1, total)),
    top3: pct(ratio(top3, total)),
    recall5: pct(ratio(recall5, total)),
    mrr: Math.round(ratio(mrr, total) * 1000) / 1000,
    duplicateCandidateRate: pct(ratio(duplicateCases, total)),
    multiRouteMergeRate: pct(ratio(multiRouteMergeCases, total)),
    routeFailureRate: pct(ratio(routeFailureCases, total)),
    serviceUnavailableRate: pct(ratio(serviceUnavailableCases, total)),
    noResultRate: pct(ratio(noResult, total)),
  }
}

function groupedSummary(cases, key) {
  const groups = new Map()
  for (const item of cases) {
    const name = String(item[key] || 'unknown')
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(item)
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, entries]) => [name, summarizeCases(entries)]),
  )
}

/**
 * 每项 case 形如：
 * { id, stratum, queryKind, gold: { doi/arxiv/title }, candidates, retrieval }
 */
export function evaluateRetrievalCases(cases = []) {
  const rows = Array.isArray(cases) ? cases : []
  return {
    scope: '分层回归金标集；不能外推为全球检索准确率',
    overall: summarizeCases(rows),
    byStratum: groupedSummary(rows, 'stratum'),
    byQueryKind: groupedSummary(rows, 'queryKind'),
    failures: rows
      .map((item) => ({ id: item.id || '', rank: relevantRank(item), ...item }))
      .filter((item) => item.rank === 0 || item.rank > 5),
  }
}

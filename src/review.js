// 译文多轮回译与整篇语义复核的纯逻辑。

import { createHash } from 'node:crypto'

import { parseCitationSpans } from './citations.js'
import { validateTranslation } from './translations.js'

export const REVIEW_PROMPT_VERSION = 1

function clean(value, limit = 1200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

export function collectReviewSegments(translations) {
  const tasks = []
  const push = (unitId, type, segments) => {
    for (const segment of segments || []) {
      const source = clean(segment.source, 1200)
      const target = clean(segment.target, 1200)
      if (!source || !target) continue
      tasks.push({
        taskId: String(segment.taskId || unitId),
        unitId,
        type,
        source,
        target,
      })
    }
  }
  push('meta:title', 'title', translations?.meta?.titleSegments)
  push('meta:abstract', 'abstract', translations?.meta?.abstractSegments)
  for (const [blockId, block] of Object.entries(translations?.blocks || {})) {
    if (block?.type === 'equation') continue
    push(blockId, block?.type || 'paragraph', block?.segments)
  }
  return tasks
}

export function chunkReviewTasks(tasks, { maxTasks = 10, maxChars = 5200 } = {}) {
  const batches = []
  let current = []
  let chars = 0
  for (const task of tasks) {
    const size = task.source.length + task.target.length
    if (current.length && (current.length >= maxTasks || chars + size > maxChars)) {
      batches.push(current)
      current = []
      chars = 0
    }
    current.push(task)
    chars += size
  }
  if (current.length) batches.push(current)
  return batches
}

export function buildBackTranslationPrompt(batch) {
  return [
    '把下面每个中文译文逐条回译成英文，供语义一致性检查使用。',
    '只回译，不解释，不合并条目；保留数字、单位、引用标记、变量名与专名。',
    '返回 JSON 对象：键等于输入 taskId，值为英文回译。',
    JSON.stringify(
      batch.map((task) => ({ taskId: task.taskId, target: task.target })),
      null,
      2,
    ),
  ].join('\n')
}

export function buildSemanticReviewPrompt(batch, backTranslations) {
  const payload = batch.map((task) => ({
    taskId: task.taskId,
    type: task.type,
    source: task.source,
    target: task.target,
    backTranslation: backTranslations[task.taskId] || '',
  }))
  return [
    '你是学术论文译文的严格审校器。比较原文、现有中文译文和英文回译。',
    '只报告真实语义问题：漏译、增译、数字/单位、引用、因果/情态强度、术语、指代、逻辑关系。',
    '不要为了润色而改译；没有问题时 issues 为空数组。',
    '可以给 revisedTarget 修正译文，但必须保留全部引用标记、数字、单位和专名。',
    'severity 只允许 error / warning；category 用简短英文。',
    '返回 JSON：{"issues":[{"taskId":"...","severity":"error|warning","category":"...","detail":"...","revisedTarget":"..."}],"warnings":["..."]}',
    JSON.stringify(payload, null, 2),
  ].join('\n')
}

export function buildIssueRepairPrompt(issues) {
  return [
    '下面这些译文问题在上一轮没有给出可用修订。请针对每条重新给出最小必要修订。',
    '只修改确认有问题的局部；保留引用、数字、单位、专名和变量名。',
    '无法可靠修订时返回空字符串，不要猜测。',
    '返回 JSON 对象：键为 taskId，值为 revisedTarget；不得缺键。',
    JSON.stringify(
      issues.map((issue) => ({
        taskId: issue.taskId,
        source: issue.source,
        target: issue.target,
        backTranslation: issue.backTranslation || '',
        detail: issue.detail,
      })),
      null,
      2,
    ),
  ].join('\n')
}

export function applyRepairSuggestions(issues, value) {
  let repaired = 0
  for (const issue of issues) {
    if (issue.revisedTarget) continue
    const revised = clean(value?.[issue.taskId], 1600)
    if (!revised || revised === issue.target) continue
    const warnings = validateTranslation(issue.source, revised)
    if (warnings.length) continue
    issue.revisedTarget = revised
    repaired += 1
  }
  return repaired
}

export function parseBackTranslations(value, expectedIds) {
  const out = {}
  for (const taskId of expectedIds) {
    const text = clean(value?.[taskId], 2000)
    if (!text) throw new Error('回译结果缺少 ' + taskId)
    out[taskId] = text
  }
  return out
}

export function normalizeReviewIssues(value, batch, backTranslations = {}) {
  const allowed = new Set(batch.map((task) => task.taskId))
  const sourceByTask = new Map(batch.map((task) => [task.taskId, task]))
  const issues = []
  for (const issue of Array.isArray(value?.issues) ? value.issues : []) {
    const taskId = String(issue?.taskId || '')
    if (!allowed.has(taskId)) continue
    const task = sourceByTask.get(taskId)
    const severity = issue?.severity === 'error' ? 'error' : 'warning'
    const revised = clean(issue?.revisedTarget, 1600)
    const item = {
      taskId,
      severity,
      category: clean(issue?.category, 60) || 'semantic',
      detail: clean(issue?.detail, 600),
      revisedTarget: revised,
      source: task.source,
      target: task.target,
      backTranslation: clean(backTranslations[taskId], 2000),
      originalTarget: task.target,
      decision: 'pending',
      decidedAt: null,
    }
    if (revised && revised === task.target) {
      item.revisedTarget = ''
    } else if (revised) {
      const warnings = validateTranslation(task.source, revised)
      if (warnings.length) {
        item.revisedTarget = ''
        item.detail += ' [revision rejected: ' + warnings.join(',') + ']'
      }
    }
    issues.push(item)
  }
  const warnings = Array.isArray(value?.warnings)
    ? value.warnings.map((entry) => clean(entry, 200)).filter(Boolean).slice(0, 12)
    : []
  return { issues, warnings }
}

export function applyReviewRevisions(translations, issues) {
  const byId = new Map()
  const index = (segments) => {
    for (const segment of segments || []) {
      const taskId = String(segment.taskId || '')
      if (taskId) byId.set(taskId, segment)
    }
  }
  index(translations?.meta?.titleSegments)
  index(translations?.meta?.abstractSegments)
  for (const block of Object.values(translations?.blocks || {})) index(block?.segments)

  let applied = 0
  const rejected = []
  for (const issue of issues) {
    const revised = clean(issue.revisedTarget, 1600)
    if (!revised) continue
    const segment = byId.get(issue.taskId)
    if (!segment) {
      rejected.push({ taskId: issue.taskId, reason: 'segment-not-found' })
      continue
    }
    const warnings = validateTranslation(segment.source, revised)
    if (warnings.length) {
      rejected.push({ taskId: issue.taskId, reason: warnings.join(',') })
      continue
    }
    if (revised === segment.target) continue
    segment.target = revised
    segment.targetSpans = parseCitationSpans(revised)
    applied += 1
  }
  if (translations?.meta?.titleSegments) {
    translations.meta.title = translations.meta.titleSegments.map((segment) => segment.target).filter(Boolean).join(' ')
  }
  if (translations?.meta?.abstractSegments) {
    translations.meta.abstract = translations.meta.abstractSegments
      .map((segment) => segment.target)
      .filter(Boolean)
      .join(' ')
  }
  for (const block of Object.values(translations?.blocks || {})) {
    block.text = (block.segments || []).map((segment) => segment.target).filter(Boolean).join(' ')
  }
  return { applied, rejected }
}

export function reviewCacheKey(source, target) {
  return createHash('sha256')
    .update([REVIEW_PROMPT_VERSION, source, target].join('\u0000'))
    .digest('hex')
    .slice(0, 24)
}

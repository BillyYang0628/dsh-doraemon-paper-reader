import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyReviewRevisions,
  applyRepairSuggestions,
  buildBackTranslationPrompt,
  buildIssueRepairPrompt,
  buildSemanticReviewPrompt,
  chunkReviewTasks,
  collectReviewSegments,
  normalizeReviewIssues,
  parseBackTranslations,
} from '../src/review.js'

function fixtureTranslations() {
  return {
    meta: {
      titleSegments: [{ taskId: 'title:0', source: 'A Paper', target: '一篇论文' }],
      title: '一篇论文',
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
  }
}

test('复核任务：收集标题/摘要/正文，跳过空译和公式', () => {
  const translations = fixtureTranslations()
  translations.blocks.e = { type: 'equation', segments: [{ taskId: 'e:0', source: 'x=1', target: 'x=1' }] }
  const tasks = collectReviewSegments(translations)
  assert.deepEqual(tasks.map((task) => task.taskId), ['title:0', 'b0:0'])
  assert.equal(chunkReviewTasks(tasks, { maxTasks: 1 }).length, 2)
  assert.match(buildBackTranslationPrompt(tasks), /taskId/)
  assert.match(buildSemanticReviewPrompt(tasks, { 'b0:0': 'The value is 42%.' }), /backTranslation/)
})

test('回译与审校结果：缺键报错，未知 taskId 被忽略', () => {
  const batch = collectReviewSegments(fixtureTranslations())
  assert.deepEqual(parseBackTranslations({ 'title:0': 'A Paper', 'b0:0': 'The value is 42%.' }, ['b0:0']), {
    'b0:0': 'The value is 42%.',
  })
  assert.throws(() => parseBackTranslations({}, ['b0:0']), /缺少/)
  const normalized = normalizeReviewIssues(
    {
      issues: [
        { taskId: 'b0:0', severity: 'error', category: 'number', detail: '42% missing', revisedTarget: '该值为 42% [1]。' },
        { taskId: 'unknown', severity: 'error', revisedTarget: 'x' },
      ],
    },
    batch,
    { 'b0:0': 'The value is 42%.' },
  )
  assert.equal(normalized.issues.length, 1)
  assert.equal(normalized.issues[0].revisedTarget, '该值为 42% [1]。')
  assert.equal(normalized.issues[0].backTranslation, 'The value is 42%.')
  assert.equal(normalized.issues[0].decision, 'pending')
})

test('审校修订：数字/引用不通过时拒绝，合法修订写回并重算 spans', () => {
  const translations = fixtureTranslations()
  const batch = collectReviewSegments(translations)
  const normalized = normalizeReviewIssues(
    {
      issues: [
        { taskId: 'b0:0', severity: 'error', revisedTarget: '该值为 42% [1]。' },
        { taskId: 'b0:0', severity: 'error', revisedTarget: '该值为 41% [1]。' },
      ],
    },
    batch,
  )
  assert.equal(normalized.issues[1].revisedTarget, '')
  const result = applyReviewRevisions(translations, normalized.issues)
  assert.equal(result.applied, 1)
  assert.equal(translations.blocks.b0.segments[0].target, '该值为 42% [1]。')
  assert.equal(translations.blocks.b0.text, '该值为 42% [1]。')
  assert.equal(translations.blocks.b0.segments[0].targetSpans[0].numbers[0], 1)
})

test('自动修复：第二轮只接受通过数字/引用校验的修订', () => {
  const issues = [
    {
      taskId: 'a',
      source: 'Value [1] is 42%.',
      target: '数值为四十。',
      backTranslation: 'The value is forty.',
      detail: 'missing number',
      revisedTarget: '',
    },
    {
      taskId: 'b',
      source: 'Another 7 items.',
      target: '另有若干项。',
      backTranslation: 'Several items.',
      detail: 'missing number',
      revisedTarget: '',
    },
  ]
  assert.match(buildIssueRepairPrompt(issues), /revisedTarget/)
  const repaired = applyRepairSuggestions(issues, {
    a: '该值为 42% [1]。',
    b: '另有 8 项。',
  })
  assert.equal(repaired, 1)
  assert.equal(issues[0].revisedTarget, '该值为 42% [1]。')
  assert.equal(issues[1].revisedTarget, '')
})

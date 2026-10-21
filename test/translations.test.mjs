import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  assembleTranslations,
  auditTranslations,
  buildTranslationPrompt,
  buildTranslationUnits,
  chunkTasks,
  flattenTasks,
  parseTranslationResponse,
  protectCitations,
  restoreCitations,
  splitSegments,
  translationCacheKey,
  validateTranslation,
} from '../src/translations.js'

test('翻译分段：按句切成小段并保留原文偏移', () => {
  const text = 'First sentence. Second sentence! Third sentence? Fourth sentence.'
  const segments = splitSegments(text, { maxChars: 40, maxSentences: 2 })
  assert.ok(segments.length >= 2)
  for (const segment of segments) {
    assert.equal(text.slice(segment.start, segment.end), segment.source)
    assert.ok(segment.source.length <= 40)
  }
  assert.equal(segments.map((segment) => segment.source).join(' '), text)
})

test('翻译单位：标题/摘要/正文/题注进入，代码与参考文献跳过', () => {
  const { units, skipped } = buildTranslationUnits({
    meta: { title: 'Title', abstract: 'Abstract text.' },
    blocks: [
      { id: 'h', type: 'heading', text: 'Introduction' },
      { id: 'p', type: 'paragraph', text: 'Body text.' },
      { id: 'r', type: 'reference', text: '1. Ref.' },
      { id: 'c', type: 'code', text: 'code()' },
      { id: 'f', type: 'figure', text: '', caption: 'Figure 1. Caption.' },
      { id: 'e', type: 'equation', text: 'x = y (1)' },
    ],
  })
  assert.deepEqual(units.map((unit) => unit.key), ['meta:title', 'meta:abstract', 'h', 'p', 'f'])
  assert.equal(skipped, 3)
})

test('翻译质量闸门：历史译文里的公式块不参与未翻译告警', () => {
  const audit = auditTranslations({
    blocks: {
      e: {
        type: 'equation',
        source: '(cid:118) MRMS = ...',
        segments: [{ taskId: 'e:0', source: '(cid:118) MRMS = ...', target: '(cid:118) MRMS = ...' }],
      },
    },
  })
  assert.equal(audit.status, 'pass')
  assert.equal(audit.counts.segments, 0)
})

test('翻译质量闸门：纯基因名/登录号片段不触发 no-cjk', () => {
  const audit = auditTranslations({
    blocks: {
      b0: {
        type: 'caption',
        source: '(merRTPABDE, merRTPCADE).',
        segments: [{ taskId: 'b0:0', source: '(merRTPABDE, merRTPCADE).', target: '(merRTPABDE, merRTPCADE)。' }],
      },
    },
  })
  assert.equal(audit.status, 'pass')
})

test('翻译批处理：按任务数与字符数切批', () => {
  const tasks = Array.from({ length: 5 }, (_, index) => ({ text: 'x'.repeat(10), id: index }))
  assert.deepEqual(chunkTasks(tasks, { maxTasks: 2, maxChars: 100 }).map((batch) => batch.length), [2, 2, 1])
})

test('翻译提示词与响应：保留引用/数字并校验', () => {
  const prompt = buildTranslationPrompt({ targetLang: 'zh-CN' })
  assert.match(prompt, /引用标记/)
  const parsed = parseTranslationResponse('{"1":"这是 [2] 的结果。"}', ['1'])
  assert.equal(parsed.get('1'), '这是 [2] 的结果。')
  assert.deepEqual(validateTranslation('Value [2] is 42%.', '数值 [2] 为 42%。'), [])
  assert.deepEqual(validateTranslation('About 200 million people.', '约 2亿人。'), [])
  assert.deepEqual(validateTranslation('First used in the 1930s.', '最早用于20世纪30年代。'), [])
  assert.ok(validateTranslation('Value [2] is 42%.', '数值为 42%。').includes('citation-markers'))
})

test('引用占位符：保护后恢复，模型漏标时补回并告警', () => {
  const protectedValue = protectCitations('A [1] and [2–3].')
  assert.match(protectedValue.text, /⟦C0⟧/)
  const restored = restoreCitations('甲 ⟦C0⟧ 与乙。', protectedValue.markers)
  assert.match(restored.text, /\[1\]/)
  assert.ok(restored.warnings.length > 0)
  assert.match(restored.text, /\[2–3\]/)
})

test('翻译装配：块与 meta 都能回填，失败段保留空译文', () => {
  const units = [
    { key: 'meta:title', blockId: '__meta_title', type: 'title', source: 'Title', segments: [{ taskId: 't', source: 'Title', start: 0, end: 5 }] },
    { key: 'b0', blockId: 'b0', type: 'paragraph', source: 'A. B.', segments: [
      { taskId: 's0', source: 'A.', start: 0, end: 2 },
      { taskId: 's1', source: 'B.', start: 3, end: 5 },
    ] },
  ]
  const result = assembleTranslations({
    units,
    translations: new Map([['t', '标题'], ['s0', '甲。']]),
    model: 'test',
  })
  assert.equal(result.meta.title, '标题')
  assert.equal(result.blocks.b0.text, '甲。')
  assert.ok(result.blocks.b0.segments[0].targetSpans)
  assert.equal(result.coverage.failed, 1)
})

test('翻译缓存键：语言/模型/提示版本/原文任一变化都换键', () => {
  const base = translationCacheKey('same', { targetLang: 'zh-CN', model: 'm', promptVersion: 1 })
  assert.equal(base, translationCacheKey('same', { targetLang: 'zh-CN', model: 'm', promptVersion: 1 }))
  assert.notEqual(base, translationCacheKey('same', { targetLang: 'zh-CN', model: 'm2', promptVersion: 1 }))
  assert.notEqual(base, translationCacheKey('other', { targetLang: 'zh-CN', model: 'm', promptVersion: 1 }))
})

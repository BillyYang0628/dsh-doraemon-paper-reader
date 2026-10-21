import { test } from 'node:test'
import assert from 'node:assert/strict'

import { extractGlossary, glossaryHash, normalizeGlossary, promptGlossary } from '../src/glossary.js'
import { auditTranslations } from '../src/translations.js'

test('术语候选：缩写、全称与重复短语', () => {
  const entries = extractGlossary({
    blocks: [
      { id: 'b0', type: 'paragraph', text: 'Antimicrobial resistance (AMR) is studied. AMR is common.' },
      { id: 'b1', type: 'paragraph', text: 'Antimicrobial resistance (AMR) remains common.' },
      { id: 'b2', type: 'paragraph', text: 'Antimicrobial resistance (AMR) is a third mention.' },
    ],
  })
  assert.ok(entries.some((entry) => entry.source === 'AMR' && entry.expanded && !entry.locked))
  assert.ok(entries.some((entry) => entry.source === 'Antimicrobial resistance'))
})

test('术语候选：普通缩写只作建议，不自动锁定或写入提示词', () => {
  const entries = extractGlossary({
    blocks: [
      { id: 'b0', type: 'paragraph', text: 'A flat-screen TV is useful. TV is common.' },
    ],
  })
  const tv = entries.find((entry) => entry.source === 'TV')
  assert.ok(tv)
  assert.equal(tv.locked, false)
  assert.equal(tv.target, '')
  assert.equal(promptGlossary(entries).some((entry) => entry.src === 'TV'), false)
})

test('术语规范化：去重、去空、锁定与提示词过滤', () => {
  const entries = normalizeGlossary([
    { id: 'a', source: 'AMR', target: 'AMR', locked: true },
    { id: 'b', source: 'AMR', target: '耐药', locked: false },
    { id: 'c', source: '', target: '空' },
    { id: 'd', source: 'plasmid', target: '质粒', locked: false },
  ])
  assert.equal(entries.length, 2)
  assert.equal(entries[0].target, 'AMR')
  const prompt = promptGlossary(entries)
  assert.deepEqual(prompt.map((entry) => entry.src), ['AMR', 'plasmid'])
  assert.notEqual(glossaryHash(entries), glossaryHash([{ ...entries[0], target: '抗微生物耐药' }]))
})

test('翻译质量闸门：空译、未翻译、无中文、引用与术语命中', () => {
  const audit = auditTranslations({
    blocks: {
      b0: {
        source: 'AMR [1] shows 42%.',
        segments: [
          { taskId: 's0', source: 'AMR [1] shows 42%.', target: '' },
          { taskId: 's1', source: 'This is another sentence.', target: 'This is another sentence.' },
          { taskId: 's2', source: 'AMR is a third concept.', target: '这是第三个概念。' },
        ],
      },
    },
    glossary: [{ source: 'AMR', target: '抗微生物耐药', locked: false }],
  })
  assert.equal(audit.status, 'fail')
  assert.ok(audit.errors.some((issue) => issue.kind === 'empty-translation'))
  assert.ok(audit.warnings.some((issue) => issue.kind === 'untranslated'))
  assert.ok(audit.warnings.some((issue) => issue.kind === 'no-cjk'))
  assert.ok(audit.warnings.some((issue) => issue.kind.startsWith('glossary-miss')))
})

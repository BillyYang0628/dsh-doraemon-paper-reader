// L0：论文术语即时查词。这里验证确定性证据、短句提取与模型结果边界。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_TERM_CHARS,
  buildTermLookupPrompt,
  classifyTerm,
  extractTermSentence,
  findLocalTermEvidence,
  normalizeSelectedTerm,
  normalizeTermLookup,
  termLookupKey,
} from '../src/terms.js'

test('术语选区：只接受短词/短语，拒绝整段文字', () => {
  assert.equal(normalizeSelectedTerm('  “Smart Sticker”. '), 'Smart Sticker')
  assert.throws(() => normalizeSelectedTerm('   '), /选择一个词/)
  assert.throws(() => normalizeSelectedTerm('word '.repeat(MAX_TERM_CHARS)), /选区太长/)
})

test('术语分类：缩写、短语、标识符与普通词', () => {
  assert.equal(classifyTerm('NFC'), 'acronym')
  assert.equal(classifyTerm('Smart Sticker'), 'phrase')
  assert.equal(classifyTerm('pIP1202'), 'identifier')
  assert.equal(classifyTerm('plasmid'), 'word')
})

test('语境句：从当前段中取包含选中词的完整句子', () => {
  const sentence = extractTermSentence(
    'Short opening. The smart sticker uses NFC for communication in the package. Another sentence follows.',
    'NFC',
  )
  assert.equal(sentence, 'The smart sticker uses NFC for communication in the package.')
  assert.equal(extractTermSentence('', 'InCA/C', 'shared ', ' backbone'), 'shared InCA/C backbone')
})

test('语境句：跳过 e.g.、i.e. 和 et al. 等缩写点', () => {
  const sentence = extractTermSentence(
    'Prior systems, e.g. RFID readers, were tested by Smith et al. in 2020. The current device uses NFC for communication. Another sentence follows.',
    'NFC',
  )
  assert.equal(sentence, 'The current device uses NFC for communication.')
})

test('论文内缩写：支持括号定义和参考文献式反向定义', () => {
  const parenthesized = findLocalTermEvidence({
    term: 'MDR',
    blocks: [
      {
        id: 'b1',
        page: 1,
        section: 'Introduction',
        text: 'The first multidrug resistant (MDR) isolate was identified in 1995.',
      },
    ],
  })
  assert.equal(parenthesized.kind, 'acronym')
  assert.equal(parenthesized.expanded, 'multidrug resistant')
  assert.equal(parenthesized.evidence.blockId, 'b1')

  const reverse = findLocalTermEvidence({
    term: 'NFC',
    blocks: [{ id: 'b2', page: 18, section: 'Abbreviations', text: 'NFC Near Field Communication' }],
  })
  assert.equal(reverse.expanded, 'Near Field Communication')
  assert.equal(reverse.evidence.quote, 'NFC Near Field Communication')
})

test('论文内缩写歧义：保留多个候选并优先当前段定义', () => {
  const local = findLocalTermEvidence({
    term: 'MDR',
    preferredBlockId: 'b2',
    blocks: [
      {
        id: 'b1',
        page: 1,
        section: 'Background',
        text: 'Medical Device Reporting (MDR) is one reporting system.',
      },
      {
        id: 'b2',
        page: 3,
        section: 'Results',
        text: 'The multidrug resistant (MDR) isolate was sequenced.',
      },
    ],
  })
  assert.equal(local.expanded, 'multidrug resistant')
  assert.equal(local.ambiguous, true)
  assert.equal(local.definitions.length, 2)
  const lookup = normalizeTermLookup(
    { kind: 'acronym', contextMeaning: '多重耐药', confidence: 'high' },
    {
      term: 'MDR',
      sentence: 'The multidrug resistant (MDR) isolate was sequenced.',
      locator: { blockId: 'b2', page: 3, section: 'Results' },
      local,
    },
  )
  assert.equal(lookup.definitions.length, 2)
  assert.match(lookup.warnings.join('；'), /2 个可能的全称/)
})

test('术语表优先：保存过的中文译名直接成为高置信解释', () => {
  const local = findLocalTermEvidence({
    term: 'plasmid',
    blocks: [],
    glossary: [{ id: 'g1', source: 'plasmid', target: '质粒', kind: 'term', locked: true }],
  })
  assert.equal(local.glossaryTarget, '质粒')
  const lookup = normalizeTermLookup(
    { kind: 'word', contextMeaning: '模型不应该覆盖术语表' },
    {
      term: 'plasmid',
      sentence: 'The plasmid carries resistance genes.',
      locator: { blockId: 'b3', page: 2, section: 'Results' },
      local,
    },
  )
  assert.equal(lookup.contextMeaning, '质粒')
  assert.equal(lookup.confidence, 'high')
  assert.equal(lookup.source, 'paper-glossary')
  assert.match(lookup.warnings.join('；'), /当前论文术语表/)
})

test('模型结果：低置信不猜、全称可由论文证据补足', () => {
  const local = findLocalTermEvidence({
    term: 'NFC',
    blocks: [{ id: 'b2', page: 18, section: 'Abbreviations', text: 'NFC Near Field Communication' }],
  })
  const lookup = normalizeTermLookup(
    {
      kind: 'acronym',
      expanded: '伪造全称',
      contextMeaning: '未能可靠确定',
      roleInSentence: '作定语',
      confidence: 'low',
      warnings: ['语境不足'],
    },
    {
      term: 'NFC',
      sentence: 'The Smart Sticker uses NFC for communication.',
      locator: { blockId: 'b4', page: 10, section: 'Methods' },
      local,
    },
  )
  assert.equal(lookup.expanded, 'Near Field Communication')
  assert.equal(lookup.contextMeaning, '论文中给出了全称，但没有可靠的中文语境解释。')
  assert.equal(lookup.confidence, 'low')
  assert.ok(lookup.warnings.includes('语境不足'))
})

test('提示词与缓存键：带当前句、段落和确定性证据', () => {
  const prompt = buildTermLookupPrompt({
    term: 'NFC',
    sentence: 'The device uses NFC for communication.',
    paragraph: 'The device uses NFC for communication and stores data in memory.',
    section: 'Methods',
    paperTitle: 'Smart Sticker',
    local: {
      expanded: 'Near Field Communication',
      evidence: { quote: 'NFC Near Field Communication' },
    },
  })
  assert.match(prompt.system, /不做英语学习建议/)
  assert.match(prompt.user, /Near Field Communication/)
  assert.match(prompt.user, /当前句/)
  const one = termLookupKey({
    jobId: 'job-aaaaaaaa',
    blockId: 'b1',
    term: 'NFC',
    sentence: prompt.user,
  })
  const two = termLookupKey({
    jobId: 'job-aaaaaaaa',
    blockId: 'b1',
    term: 'NFC',
    sentence: prompt.user,
  })
  assert.equal(one, two)
  assert.notEqual(
    one,
    termLookupKey({ jobId: 'job-aaaaaaaa', blockId: 'b2', term: 'NFC', sentence: prompt.user }),
  )
})

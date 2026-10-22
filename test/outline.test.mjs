import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildOutlineSource,
  buildSemanticOutlinePrompt,
  fallbackOutline,
  normalizeSemanticOutline,
  outlineDisplayGroups,
} from '../src/outline.js'

function doc() {
  return {
    meta: {
      title: 'Semantic Outline Test',
      abstract: 'This paper studies a lightweight method for plant disease detection.',
      brief: {
        sections: [
          { heading: '1. Introduction', gist: 'Background and research gap.' },
          { heading: '2. Methods', gist: 'A hybrid model and experiment design.' },
          { heading: '3. Results', gist: 'Accuracy improves on the test set.' },
        ],
      },
    },
    blocks: [
      { id: 'b1', type: 'heading', text: '1. Introduction', page: 1, level: 1 },
      { id: 'b2', type: 'paragraph', text: 'Small farms need accessible tools for disease detection.', page: 1 },
      { id: 'b3', type: 'heading', text: '2. Methods', page: 2, level: 1 },
      { id: 'b4', type: 'paragraph', text: 'The method combines convolutional and transformer blocks for local and global features.', page: 2 },
      { id: 'b5', type: 'table', text: 'Table 1: Results', page: 3, label: 'Table 1' },
      { id: 'b6', type: 'algorithm', text: 'Algorithm 1', page: 3 },
      { id: 'b7', type: 'heading', text: '3. Results', page: 4, level: 1 },
      { id: 'b8', type: 'heading', text: 'References', page: 5, level: 1 },
    ],
  }
}

test('语义目录输入：保留 heading，排除表格/算法/参考文献', () => {
  const source = buildOutlineSource(doc())
  assert.deepEqual(
    source.entries.map((entry) => entry.blockId),
    ['__meta_abstract', 'b1', 'b3', 'b7'],
  )
  assert.match(source.entries[2].gist, /hybrid model/)
})

test('语义目录提示词：只允许已有 blockId，并要求 JSON', () => {
  const prompt = buildSemanticOutlinePrompt(doc())
  assert.match(prompt.system, /每个 blockId 恰好出现一次/)
  assert.match(prompt.system, /只输出 JSON/)
  assert.match(prompt.user, /blockId=b1/)
})

test('语义目录回退：确定性两层分组且保留原 heading 与锚点', () => {
  const outline = fallbackOutline(doc())
  assert.equal(outline.semantic, false)
  assert.ok(outline.groups.length >= 3)
  const items = outline.groups.flatMap((group) => group.items)
  assert.deepEqual(items.map((item) => item.blockId), ['__meta_abstract', 'b1', 'b3', 'b7'])
  assert.equal(items.find((item) => item.blockId === 'b3').originalTitle, '2. Methods')
})

test('语义目录模型结果：非法 blockId 被丢弃，缺失 heading 补入其他章节', () => {
  const outline = normalizeSemanticOutline(
    {
      groups: [
        {
          label: '方法与结果',
          summary: '模型把方法与结果放在一起。',
          items: [
            { blockId: 'b3', label: '混合检测方法', summary: '卷积与 Transformer 结合' },
            { blockId: 'bad', label: '伪造标题', summary: '' },
            { blockId: 'b5', label: 'Table 1', summary: '' },
          ],
        },
      ],
    },
    doc(),
  )
  assert.equal(outline.semantic, true)
  const items = outline.groups.flatMap((group) => group.items)
  assert.deepEqual(items.map((item) => item.blockId), ['b3', '__meta_abstract', 'b1', 'b7'])
  assert.equal(outline.coverage, 1)
  assert.ok(outline.groups.some((group) => group.label === '其他章节'))
})

test('语义目录语言展示：中文、原文、对照三种模式', () => {
  const outline = normalizeSemanticOutline(
    {
      groups: [
        {
          label: '研究方法',
          summary: '',
          items: [{ blockId: 'b3', label: '混合模型方法', summary: '' }],
        },
      ],
    },
    doc(),
  )
  const zh = outlineDisplayGroups(outline, 'zh')[0].items[0]
  const original = outlineDisplayGroups(outline, 'original')[0].items[0]
  const bilingual = outlineDisplayGroups(outline, 'bilingual')[0].items[0]
  assert.equal(zh.label, '混合模型方法')
  assert.equal(original.label, '2. Methods')
  assert.equal(bilingual.label, '混合模型方法')
  assert.equal(bilingual.secondary, '2. Methods')
})

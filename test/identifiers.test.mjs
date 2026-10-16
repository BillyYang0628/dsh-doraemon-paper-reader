import test from 'node:test'
import assert from 'node:assert/strict'
import { parseIdentifiers, normalizeDoi, normalizeArxiv } from '../src/identifiers.js'

test('DOI：裸值 / URL / 尾部标点', () => {
  assert.equal(normalizeDoi('10.1103/PhysRevLett.116.061102'), '10.1103/physrevlett.116.061102')
  assert.equal(normalizeDoi('https://doi.org/10.48550/arXiv.1706.03762.'), '10.48550/arxiv.1706.03762')
})

test('arXiv：新式带版本 / 旧式 / 前缀写法', () => {
  assert.equal(normalizeArxiv('1706.03762v2'), '1706.03762v2')
  assert.equal(normalizeArxiv('arXiv:1706.03762'), '1706.03762')
  assert.equal(normalizeArxiv('cs/0701001'), 'cs/0701001')
})

test('parseIdentifiers：形态判定优先级', () => {
  assert.equal(parseIdentifiers('10.1103/PhysRevLett.116.061102').form, 'doi')
  assert.equal(parseIdentifiers('arXiv:1706.03762v2').form, 'arxiv')
  assert.equal(parseIdentifiers('PMID: 33961774').form, 'pmid')
  assert.equal(parseIdentifiers('Attention Is All You Need').form, 'title')
})

test('parseIdentifiers：同时带走可用信息', () => {
  const r = parseIdentifiers('见 https://arxiv.org/abs/1706.03762v2 （预印本）')
  assert.equal(r.arxiv, '1706.03762v2')
  assert.equal(r.url, 'https://arxiv.org/abs/1706.03762v2')
})

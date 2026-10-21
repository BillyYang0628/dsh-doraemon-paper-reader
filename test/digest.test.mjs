// L0：多篇对照的论文精简档案。
//
// 这里只验确定性抽取：元数据、章节 blockId、关键段、字符预算与目录栅栏。
// 模型怎么比较属于 compare.test.mjs；真实界面属于 L2。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  DIGEST_CHAR_LIMIT,
  buildPaperDigest,
  createPaperDigestReader,
  digestToText,
} from '../src/digest.js'

function fixtureDoc({ extraParagraph = '' } = {}) {
  return {
    version: { kind: 'preprint', label: 'arXiv 预印本', source: 'arXiv' },
    meta: {
      title: 'A Paper About Sensors',
      authors: 'A. Author, B. Author',
      doi: '10.1000/example',
      arxivId: '2501.01234v2',
      license: 'CC BY 4.0',
      abstract: 'This paper studies a sensor. ' + extraParagraph,
      brief: {
        sections: [
          { heading: '1 Introduction', page: 1, gist: 'Why the sensor matters.' },
          { heading: '2 Methods', page: 2, gist: 'How the sensor was built.' },
          { heading: '3 Results', page: 4, gist: 'What the sensor measured.' },
        ],
        figures: [{ label: 'Figure 1' }, { label: 'Figure 2' }],
        tables: [{ label: 'Table 1' }],
        equations: [],
        referenceCount: 12,
      },
    },
    blocks: [
      { id: 'b0001', type: 'heading', text: '1 Introduction', section: '1 Introduction', page: 1 },
      {
        id: 'b0002',
        type: 'paragraph',
        text: 'Sensors are important because they measure things in the physical world with a long enough paragraph to pass the excerpt gate.',
        section: '1 Introduction',
        page: 1,
      },
      { id: 'b0003', type: 'heading', text: '2 Methods', section: '2 Methods', page: 2 },
      {
        id: 'b0004',
        type: 'paragraph',
        text: 'We built the sensor with a microcontroller, a radio, and a battery, then calibrated it against a reference instrument in the lab.',
        section: '2 Methods',
        page: 3,
      },
      { id: 'b0005', type: 'heading', text: '3 Results', section: '3 Results', page: 4 },
      {
        id: 'b0006',
        type: 'paragraph',
        text: 'The sensor achieved a root mean square error of 0.42 units and stayed within five percent of the reference over the full range.',
        section: '3 Results',
        page: 4,
      },
      {
        id: 'b0007',
        type: 'paragraph',
        text: 'A limitation is that the calibration was performed at room temperature only, so drift at other temperatures remains unknown.',
        section: '3 Results',
        page: 5,
      },
    ],
  }
}

test('档案：标题/摘要/章节 blockId/关键段都在，年份从 arXiv 号取', () => {
  const digest = buildPaperDigest({ jobId: 'job-00000001', doc: fixtureDoc() })
  assert.equal(digest.title, 'A Paper About Sensors')
  assert.equal(digest.year, 2025)
  assert.equal(digest.sections.length, 3)
  assert.equal(digest.sections[0].blockId, 'b0001')
  assert.equal(digest.sections[1].blockId, 'b0003')
  assert.ok(digest.excerpts.some((excerpt) => excerpt.blockId === 'b0006'))
  assert.equal(digest.counts.figures, 2)
  assert.equal(digest.counts.tables, 1)
  assert.equal(digest.counts.references, 12)
  assert.deepEqual(digest.versionInfo, {
    kind: 'preprint',
    label: 'arXiv 预印本',
    source: 'arXiv',
  })
  assert.ok(digest.charCount <= DIGEST_CHAR_LIMIT)
})

test('档案：超长文本按预算裁关键段，标题与摘要保留', () => {
  const long = 'word '.repeat(5000)
  const doc = fixtureDoc({ extraParagraph: long })
  const digest = buildPaperDigest({ jobId: 'job-00000002', doc })
  assert.equal(digest.title, 'A Paper About Sensors')
  assert.ok(digest.abstract.length <= 620)
  assert.ok(digest.charCount <= DIGEST_CHAR_LIMIT)
})

test('档案文本：带 P1 标签、jobId 与 blockId，供提示词定位', () => {
  const digest = buildPaperDigest({ jobId: 'job-00000003', doc: fixtureDoc() })
  const text = digestToText(digest, 'P1')
  assert.match(text, /^\[P1\]/)
  assert.match(text, /jobId=job-00000003/)
  assert.match(text, /arXiv 预印本/)
  assert.match(text, /b0001/)
  assert.match(text, /关键段/)
})

test('读取器：只读 jobs 下带 mirrordoc 的作业，拒绝越界与超量', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dpr-digest-'))
  const jobId = 'job-00000004'
  await mkdir(path.join(root, jobId), { recursive: true })
  await writeFile(path.join(root, jobId, 'mirrordoc.json'), JSON.stringify(fixtureDoc()), 'utf8')
  const reader = createPaperDigestReader({ jobsRoot: root })

  const digests = await reader.readDigests([jobId])
  assert.equal(digests.length, 1)
  assert.equal(digests[0].jobId, jobId)

  const block = await reader.readBlock(jobId, 'b0004')
  assert.equal(block.page, 3)
  assert.match(block.text, /microcontroller/)

  await assert.rejects(() => reader.readDigests(['../etc']), /形状不对/)
  await assert.rejects(
    () => reader.readDigests(['job-00000004', 'job-00000005', 'job-00000006', 'job-00000007']),
    /最多/,
  )
})

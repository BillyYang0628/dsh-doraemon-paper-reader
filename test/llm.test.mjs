import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { loadDeepseekKey, parseJsonObject, visionJson } from '../src/llm.js'

test('模型 JSON：容忍围栏和前后说明', () => {
  assert.deepEqual(parseJsonObject('```json\n{"ok":true}\n```'), { ok: true })
  assert.deepEqual(parseJsonObject('说明\n{"ok":false}\n结束'), { ok: false })
})

test('模型 key：环境变量优先，缺省时读 $DSH_HOME/.env', async () => {
  assert.equal(await loadDeepseekKey({ env: { DEEPSEEK_API_KEY: 'direct' }, home: '' }), 'direct')
  const home = await mkdtemp(path.join(os.tmpdir(), 'dpr-llm-'))
  try {
    await writeFile(path.join(home, '.env'), 'OTHER=x\nDEEPSEEK_API_KEY="from-file"\n', 'utf8')
    assert.equal(await loadDeepseekKey({ env: {}, home }), 'from-file')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('视觉 JSON：本地裁剪图按 data URL 发送，并解析 JSON 围栏', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dpr-vision-'))
  const imagePath = path.join(root, 'equation.png')
  let body = null
  try {
    await writeFile(imagePath, Buffer.from([137, 80, 78, 71]))
    const result = await visionJson({
      system: '只输出 JSON',
      user: '转写公式',
      imagePath,
      apiKey: 'test-key',
      fetchImpl: async (_url, options) => {
        body = JSON.parse(options.body)
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: '```json\n{"latex":"x=1"}\n```' } }],
          }),
        }
      },
    })
    assert.equal(result.latex, 'x=1')
    assert.equal(body.model, 'deepseek-flash')
    assert.equal(body.messages[1].content[0].type, 'text')
    assert.match(body.messages[1].content[1].image_url.url, /^data:image\/png;base64,/)
    assert.equal(body.messages[1].content[1].image_url.detail, 'high')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// 极小的 DeepSeek JSON 调用层。
//
// 只从环境变量或 $DSH_HOME/.env 读 key；不在日志、错误信息或返回值里回显。
// 供引用预览的"概览 + 关系"使用，不引入任何第三方 SDK。

import { readFile } from 'node:fs/promises'
import path from 'node:path'

const ENDPOINT = 'https://api.deepseek.com/chat/completions'

function imageMime(file) {
  const value = String(file || '').toLowerCase()
  if (value.endsWith('.png')) return 'image/png'
  if (value.endsWith('.webp')) return 'image/webp'
  if (value.endsWith('.gif')) return 'image/gif'
  return 'image/jpeg'
}

/** 从 env 或 $DSH_HOME/.env 读取 key。 */
export async function loadDeepseekKey({ env = process.env, home = process.env.DSH_HOME } = {}) {
  const direct = String(env.DEEPSEEK_API_KEY || '').trim()
  if (direct) return direct
  if (!home) return ''
  try {
    const text = await readFile(path.join(home, '.env'), 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
      const [name, ...rest] = trimmed.split('=')
      if (name.trim() !== 'DEEPSEEK_API_KEY') continue
      return rest.join('=').trim().replace(/^["']|["']$/g, '')
    }
  } catch {
    // 没有 .env 时由调用方给出可读错误。
  }
  return ''
}

/** 从模型回复里取出 JSON 对象，容忍 ```json 围栏。 */
export function parseJsonObject(text) {
  let value = String(text ?? '').trim()
  value = value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = value.indexOf('{')
  const end = value.lastIndexOf('}')
  if (start >= 0 && end > start) value = value.slice(start, end + 1)
  return JSON.parse(value)
}

/**
 * 调一次 DeepSeek chat completions，要求 JSON object 输出。
 * @param {object} options - system/user/model/fetchImpl/timeoutMs/apiKey。
 * @returns {Promise<object>} 解析后的 JSON。
 */
export async function chatJson({
  system,
  user,
  model = 'deepseek-chat',
  fetchImpl = fetch,
  timeoutMs = 90000,
  apiKey,
  maxTokens = 3200,
} = {}) {
  const key = apiKey || (await loadDeepseekKey())
  if (!key) {
    throw Object.assign(new Error('没有找到 DEEPSEEK_API_KEY；引用概览暂不可用。'), { code: 'NO_API_KEY' })
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: String(system || '只输出 JSON。') },
          { role: 'user', content: String(user || '') },
        ],
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      throw Object.assign(new Error('模型返回 HTTP ' + response.status), { statusCode: response.status })
    }
    const payload = await response.json()
    const content = payload?.choices?.[0]?.message?.content
    if (!content) throw new Error('模型没有返回内容')
    return parseJsonObject(content)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 调一次 DeepSeek chat completions，返回纯文本（对照工作台的对话用）。
 * 与 chatJson 共用端点与 key 读取，但不要求 JSON 输出。
 * @param {object} options - system/user/model/fetchImpl/timeoutMs/apiKey/maxTokens。
 * @returns {Promise<string>} 模型回答正文。
 */
export async function chatText({
  system,
  user,
  model = 'deepseek-chat',
  fetchImpl = fetch,
  timeoutMs = 120000,
  apiKey,
  maxTokens = 2200,
} = {}) {
  const key = apiKey || (await loadDeepseekKey())
  if (!key) {
    throw Object.assign(new Error('没有找到 DEEPSEEK_API_KEY；对照工作台暂不可用。'), { code: 'NO_API_KEY' })
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: String(system || '') },
          { role: 'user', content: String(user || '') },
        ],
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      throw Object.assign(new Error('模型返回 HTTP ' + response.status), { statusCode: response.status })
    }
    const payload = await response.json()
    const content = payload?.choices?.[0]?.message?.content
    if (!content) throw new Error('模型没有返回内容')
    return String(content)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 调一次带单张本地图片的 DeepSeek vision 请求，并要求 JSON object。
 * 只传单个裁剪资产，不要把整页全尺寸图塞进每次请求。
 * @param {object} options - system/user/imagePath/model/fetchImpl/timeoutMs/apiKey/maxTokens。
 * @returns {Promise<object>} 解析后的 JSON。
 */
export async function visionJson({
  system,
  user,
  imagePath,
  model = 'deepseek-flash',
  fetchImpl = fetch,
  timeoutMs = 120000,
  apiKey,
  maxTokens = 3200,
  detail = 'high',
} = {}) {
  const key = apiKey || (await loadDeepseekKey())
  if (!key) {
    throw Object.assign(new Error('没有找到 DEEPSEEK_API_KEY；图像转写暂不可用。'), { code: 'NO_API_KEY' })
  }
  if (!imagePath) throw new Error('visionJson 需要 imagePath')
  const bytes = await readFile(imagePath)
  if (bytes.length > 8 * 1024 * 1024) {
    throw Object.assign(new Error('单张裁剪图超过 8 MB，拒绝送入视觉模型'), { statusCode: 413 })
  }
  const dataUrl = 'data:' + imageMime(imagePath) + ';base64,' + bytes.toString('base64')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + key,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: String(system || '只输出 JSON。') },
          {
            role: 'user',
            content: [
              { type: 'text', text: String(user || '') },
              { type: 'image_url', image_url: { url: dataUrl, detail } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      throw Object.assign(new Error('视觉模型返回 HTTP ' + response.status), { statusCode: response.status })
    }
    const payload = await response.json()
    const content = payload?.choices?.[0]?.message?.content
    if (!content) throw new Error('视觉模型没有返回内容')
    return parseJsonObject(content)
  } finally {
    clearTimeout(timer)
  }
}

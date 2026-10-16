// identifiers.js —— 纯函数：把用户输入统一成"论文标识符"。
// 不依赖 Cordis、不联网，可被 node --test 直接覆盖（L0 层）。

const DOI_RE = /\b10\.\d{4,9}\/[-._;()/:a-z0-9]+\b/i
const ARXIV_NEW_RE = /\b(\d{4}\.\d{4,5})(v\d+)?\b/
const ARXIV_OLD_RE = /\b([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?\b/
const PMID_RE = /\bpmid[:\s#]*(\d{7,8})\b/i

/** 去掉常见尾部标点（论文标题/DOI 粘贴时很常见）。 */
export function trimTrailing(text) {
  return String(text ?? '').trim().replace(/[.,;:)\]}'"]+$/, '')
}

/** DOI 规范化：小写、去前缀 URL、去尾部标点。 */
export function normalizeDoi(raw) {
  const text = trimTrailing(String(raw ?? ''))
  const m = text.match(DOI_RE)
  return m ? m[0].toLowerCase() : undefined
}

/** arXiv ID 规范化：保留版本号（v2 之类），因为版本对精读很关键。 */
export function normalizeArxiv(raw) {
  const text = trimTrailing(String(raw ?? ''))
  const modern = text.match(ARXIV_NEW_RE)
  if (modern) return modern[1] + (modern[2] ?? '')
  const legacy = text.match(ARXIV_OLD_RE)
  return legacy ? legacy[1] + (legacy[2] ?? '') : undefined
}

/**
 * 解析任意输入，返回识别到的标识符集合与建议的输入形态。
 * @param {string} input 用户粘贴或键入的任意文本
 * @returns {{ form: 'doi'|'arxiv'|'pmid'|'url'|'title', doi?: string, arxiv?: string, pmid?: string, url?: string, raw: string }}
 */
export function parseIdentifiers(input) {
  const raw = String(input ?? '').trim()
  const doi = normalizeDoi(raw)
  const arxiv = normalizeArxiv(raw)
  const pmidMatch = raw.match(PMID_RE)

  const result = { form: 'title', raw }
  if (doi) result.doi = doi
  if (arxiv) result.arxiv = arxiv
  if (pmidMatch) result.pmid = pmidMatch[1]

  const urlMatch = raw.match(/https?:\/\/\S+/i)
  if (urlMatch) result.url = urlMatch[0]

  // 形态判定：显式标识符优先，其次 URL，最后才当成标题（标题需要联网匹配）
  if (doi) result.form = 'doi'
  else if (arxiv) result.form = 'arxiv'
  else if (result.pmid) result.form = 'pmid'
  else if (urlMatch) result.form = 'url'

  return result
}

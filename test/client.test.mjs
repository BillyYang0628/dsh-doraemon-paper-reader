// L0：浏览器半区（src/client.js）的纯逻辑与接线自检。
//
// 跑法：`npm test`。不需要 Harness、不需要浏览器——这里验的是「这一半自己是否自洽」：
// 清单字段、登记的名字/键、字典键集、主界面的两条入口、像素稿的网格与色板来源、
// 以及「容器只用宿主 token」这条硬规则。真实观感属于 L2（要浏览器），不在这里冒充。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_FILE = path.join(ROOT, 'src', 'client.js')

/** 记录被插入的 <style>，用来验 CSS 注入约定（宿主靠 data-plugin 认领并随模块回收）。 */
const styleTags = []
const fakeDocument = {
  querySelector(selector) {
    return styleTags.find((tag) => selector.includes(tag.dataset.pluginCss)) ?? null
  },
  createElement() {
    return { dataset: {}, textContent: '' }
  },
  head: {
    appendChild(node) {
      styleTags.push(node)
    },
  },
}

/** 只记形状的 React 替身：够我们把组件当成纯函数调用并把元素树走一遍。 */
const React = {
  Fragment: Symbol('Fragment'),
  createElement(type, props, ...children) {
    const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
    return { type, props: props ?? {}, children: flat }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useRef(value) {
    return { current: value }
  },
  useMemo(factory) {
    return factory()
  },
}

let registration
const storage = new Map()
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      registration = value
    },
  },
  localStorage: {
    getItem(key) {
      return storage.get(key) ?? null
    },
    setItem(key, value) {
      storage.set(key, String(value))
    },
    removeItem(key) {
      storage.delete(key)
    },
  },
  addEventListener() {},
  removeEventListener() {},
}
globalThis.document = fakeDocument
await import(pathToFileURL(CLIENT_FILE).href)

const client = registration.factory((specifier) => {
  assert.equal(specifier, 'react', '浏览器半区只允许 require 模块表里的 react')
  return React
})
const { __testables: T } = client

/** 搭一个假 ctx：把每个登记原样收下来，便于断言「登记了什么」。 */
function makeCtx() {
  const captured = { tabs: [], slots: [], dictionaries: [], effects: [], slotOwners: [] }
  const ctx = {
    effect(callback, label) {
      const disposer = callback()
      captured.effects.push({ label, disposer })
      return disposer
    },
    locale: {
      register(namespace, dictionaries) {
        captured.dictionaries.push({ namespace, dictionaries })
        return () => {}
      },
      bind() {
        return (key) => T.DICT_ZH[key] ?? key
      },
    },
    sidebarRightTabs: {
      register(definition) {
        captured.tabs.push(definition)
        return () => {}
      },
    },
    slots: {
      inject(owner, callback) {
        captured.slotOwners.push(owner)
        return callback()
      },
      register(options, component) {
        captured.slots.push({ options, component })
        return () => {}
      },
    },
  }
  return { ctx, captured }
}

const { ctx, captured } = makeCtx()
client.apply(ctx)

const tZh = (key) => T.DICT_ZH[key] ?? key
const tEn = (key) => T.DICT_EN[key] ?? key

/** 深度优先走一遍元素树。 */
function walk(node, visit) {
  if (node === null || typeof node !== 'object') return
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

/** 收集树里所有文本节点。 */
function collectText(node) {
  const out = []
  walk(node, (element) => {
    for (const child of element.children ?? []) {
      if (typeof child === 'string') out.push(child)
    }
  })
  return out
}

/** 按条件找元素。 */
function findAll(node, predicate) {
  const out = []
  walk(node, (element) => {
    if (predicate(element)) out.push(element)
  })
  return out
}

/** 渲染主界面/路径页正文用的标准 props（useTabInfo 是我们自己塞的桩）。 */
function makeProps(extra) {
  const opened = []
  const props = {
    useTabInfo: () => ({ tab: { actions: { openTab: (kind, options) => opened.push({ kind, options }) } } }),
    t: tZh,
    ...extra,
  }
  return { props, opened }
}

test('清单：dsh.client 声明与 ./client 导出都指向真实文件', async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.name, 'dsh-doraemon-paper-reader')
  assert.equal(manifest.dsh.client.platform, 'web', '平台必须是 web')
  assert.equal(manifest.dsh.client.immediately, true, 'UI 插件要在启动早期就位')
  assert.deepEqual(manifest.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-sidebar-right'])
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(existsSync(path.join(ROOT, manifest.dsh.bundle.patch)), 'cordis.patch.yml 必须在')
  assert.equal(manifest.exports['./client'], './src/client.js')
  assert.ok(existsSync(path.join(ROOT, 'src', 'client.js')), './client 指向的文件必须在')
  assert.ok(manifest.files.includes('src'), 'src 必须在发布白名单里（K8）')
  assert.ok(manifest.files.includes('assets'), 'assets 必须在发布白名单里（K8：插画不在文件里 = 线上缺图）')
  assert.ok(manifest.files.includes('cordis.patch.yml'))
  for (const file of [
    '工具/pdf-pipeline/extract_pdf.py',
    '工具/pdf-pipeline/render_html.py',
    '工具/pdf-pipeline/requirements.txt',
  ]) {
    assert.ok(manifest.files.includes(file), 'PDF 管线脚本必须在 files 里：' + file)
  }
})

test('模块登记：id 等于包名，注入六个服务', () => {
  assert.equal(registration.id, 'dsh-doraemon-paper-reader', 'id 必须等于包名')
  assert.deepEqual(client.inject, ['slots', 'sidebarRightTabs', 'locale', 'sidebarRight', 'sessions', 'conversation'])
  assert.equal(typeof client.apply, 'function')
})

test('CSS 注入：带 data-plugin / data-plugin-css，容器只用宿主 token', () => {
  assert.equal(styleTags.length, 1, '每次物化只挂一个 style 标签')
  const tag = styleTags[0]
  assert.equal(tag.dataset.plugin, 'dsh-doraemon-paper-reader')
  assert.equal(tag.dataset.pluginCss, 'dsh-doraemon-paper-reader/client.css')
  assert.ok(tag.textContent.includes('--dsw-'), '必须吃宿主主题 token')
  const literals = [...new Set(tag.textContent.match(/#[0-9A-Fa-f]{6}/g) ?? [])]
  const artworkOnly = ['#EDE0C6', '#10101A', '#428AC7']
  assert.deepEqual(
    literals.filter((color) => !artworkOnly.includes(color)),
    [],
    '容器与控件不许出现字面色值（字面值只能给插画：米白底、墨蓝黑描边、主蓝像素点）',
  )
  assert.ok(tag.textContent.includes('--dsw-radius-'), '圆角走宿主 token（界面风格 §4 的落地方式）')
  assert.ok(tag.textContent.includes('--dsh-content-font-size'), '字号跟随宿主的正文字号设置')
})

test('UI 基础系统：语义 token、共享表面与动效降级已落地', () => {
  const css = styleTags[0].textContent
  for (const token of [
    '--dpr-space-1',
    '--dpr-space-4',
    '--dpr-radius-md',
    '--dpr-font-title',
    '--dpr-surface-raised',
    '--dpr-surface-soft',
    '--dpr-paper',
    '--dpr-line-strong',
    '--dpr-ink-secondary',
    '--dpr-brand',
    '--dpr-brand-strong',
    '--dpr-on-brand',
    '--dpr-shadow-card',
    '--dpr-ease',
  ]) {
    assert.ok(css.includes(token), '缺少基础 token：' + token)
  }
  assert.match(css, /\.dpr-card\{[\s\S]*box-shadow:var\(--dpr-shadow-card\)/)
  assert.match(css, /\.dpr-primary\{[\s\S]*background:var\(--dpr-brand-strong\)/)
  assert.match(css, /\.dpr-drop::before\{[\s\S]*background:var\(--dpr-surface-raised\)/)
  assert.match(css, /body\[data-ds-dark-theme\][\s\S]*--dpr-surface-base:color-mix/)
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{[\s\S]*transition:none/)
})

test('阅读页摘要：使用稳定 blockId 接入同一套选区与气泡链路', async () => {
  const source = await readFile(CLIENT_FILE, 'utf8')
  assert.match(source, /id:\s*'__meta_abstract'/)
  assert.match(source, /'data-block-id':\s*'__meta_abstract'/)
  assert.match(source, /'data-source-text':\s*doc\.meta\.abstract/)
  assert.match(source, /bubbleFor\(\{\s*id:\s*'__meta_abstract'\s*\}\)/)
})

test('阅读页公式：只显示原图与编号，不把伪字形当题注展示', async () => {
  const source = await readFile(CLIENT_FILE, 'utf8')
  assert.match(source, /block\.type === 'equation' \? '' : block\.caption \|\| block\.text \|\| ''/)
})

test('阅读页增强：公式/表格按钮、回跳 BroadcastChannel 与整篇复核入口已接线', async () => {
  const source = await readFile(CLIENT_FILE, 'utf8')
  assert.match(source, /startVisualJob\('formulas'\)/)
  assert.match(source, /startVisualJob\('tables'\)/)
  assert.match(source, /new BroadcastChannel\('doraemon-paper-reader'\)/)
  assert.match(source, /const startReview = async/)
  assert.match(source, /function ReviewDialog/)
  assert.match(source, /算法已自动修订/)
  assert.match(source, /dpr-versionSelect/)
})

test('UI 样张落地：主界面/PDF/阅读/对照使用新页级结构', async () => {
  const source = await readFile(CLIENT_FILE, 'utf8')
  assert.match(source, /dpr-heroCopy/)
  assert.match(source, /dpr-mascotSticker/)
  assert.match(source, /dpr-cardIndex/)
  assert.match(source, /dpr-pageTopbar/)
  assert.match(source, /dpr-stepper/)
  assert.match(source, /dpr-fileCard/)
  assert.match(source, /dpr-readerOutline/)
  assert.match(source, /dpr-readerArticle/)
  assert.match(source, /dpr-cmpMetric/)
  assert.match(
    source,
    /\.dpr-loadHero\{[\s\S]*grid-template-columns:112px minmax\(0,1fr\)[\s\S]*gap:16px/,
  )
  assert.match(source, /\.dpr-loadHero \.dpr-mascotSlot img\{max-width:92px\}/)
  assert.match(
    source,
    /\.dpr-importHero\{[\s\S]*grid-template-columns:minmax\(0,1fr\) 104px[\s\S]*margin-bottom:24px/,
  )
  assert.match(source, /\.dpr-importMascot \.dpr-mascot\{[\s\S]*width:96px;[\s\S]*height:96px/)
  assert.match(
    source,
    /@media \(max-width:420px\)\{[\s\S]*\.dpr-importMascot \.dpr-mascot\{width:80px;height:80px\}/,
  )
})

test('页签类型：五个 kind，id 唯一，都是「按 kind 打开」的页类型', () => {
  assert.equal(captured.tabs.length, 5)
  const kinds = captured.tabs.map((tab) => tab.kind)
  assert.deepEqual(kinds, [
    T.HOME_KIND,
    'doraemon-paper-file',
    'doraemon-paper-lookup',
    T.READER_KIND,
    T.SURVEY_KIND,
  ])
  for (const kind of kinds) assert.ok(kind.startsWith('doraemon-paper'), `kind 必须带前缀：${kind}`)
  const ids = captured.tabs.map((tab) => tab.id)
  assert.equal(new Set(ids).size, 5, 'id 全系统唯一')
  for (const id of ids) assert.ok(id.startsWith('dsh-doraemon-paper-reader'), `id 必须带包名前缀：${id}`)
  for (const tab of captured.tabs) {
    if (tab.kind === T.READER_KIND) {
      assert.deepEqual(
        tab.patterns,
        [
          'dsh-resource://doraemon-paper/**',
          'dsh-resource://file/**/*.dprcite',
          'dsh-resource://file/**/doraemon-paper-cites/**/*.dprcite',
          'dsh-resource://file/session/*/work/doraemon-paper-cites/*/*.dprcite',
          '**/*.dprcite',
        ],
        '阅读页认领引用链接',
      )
    } else {
      assert.equal(tab.patterns, undefined, '普通页类型不认领 dsh-resource 地址')
    }
    assert.ok(tZh(tab.title('sidebar://' + tab.kind)).length > 0)
    assert.ok(tEn(tab.title('sidebar://' + tab.kind)).length > 0)
  }
})

test('引导页入口：只贡献一个胶囊，且标题/描述两种语言都有', () => {
  const entries = captured.tabs.flatMap((tab) => tab.guide ?? [])
  assert.equal(entries.length, 1)
  const entry = entries[0]
  assert.equal(entry.id, 'start')
  assert.equal(typeof entry.order, 'number')
  assert.equal(typeof entry.icon, 'function', '引导页胶囊要自带图标组件（不 import 官方 primitives）')
  assert.ok(tZh(entry.title()).length > 0)
  assert.ok(tZh(entry.description()).length > 0)
  assert.ok(tEn(entry.title()).length > 0)
  assert.ok(tEn(entry.description()).length > 0)
})

test('正文登记：五个页签 + 全宽对照 overlay，键等于类型 id，声明 locale', () => {
  assert.deepEqual(
    [...new Set(captured.slotOwners)].sort(),
    ['conversation.input.dock', 'shell.overlay', 'sidebar.right.pane.tab'],
  )
  const sidebarSlots = captured.slots.filter((slot) => slot.options.name === 'sidebar.right.pane.tab')
  const dockSlots = captured.slots.filter((slot) => slot.options.name === 'conversation.input.dock')
  const overlaySlots = captured.slots.filter((slot) => slot.options.name === 'shell.overlay')
  assert.equal(sidebarSlots.length, 5)
  assert.equal(dockSlots.length, 1)
  assert.equal(overlaySlots.length, 1)
  assert.equal(dockSlots[0].options.id, 'doraemon-annotations')
  assert.equal(typeof dockSlots[0].component, 'function')
  assert.equal(overlaySlots[0].options.id, T.COMPARE_ID)
  assert.equal(overlaySlots[0].options.locale, T.NS)
  assert.equal(typeof overlaySlots[0].component, 'function')
  const ids = captured.tabs.map((tab) => tab.id).sort()
  const keys = sidebarSlots.map((slot) => slot.options.key).sort()
  assert.deepEqual(keys, ids, '正文注册键必须等于类型 id（派发就是这么找的）')
  for (const slot of sidebarSlots) {
    assert.equal(slot.options.name, 'sidebar.right.pane.tab')
    assert.equal(slot.options.locale, T.NS)
    assert.equal(slot.options.children, undefined, '不接管别人的子槽位')
    assert.equal(typeof slot.component, 'function')
  }
})

test('字典：命名空间带前缀，zh / en 键集完全一致，无空值', () => {
  assert.equal(captured.dictionaries.length, 1)
  const { namespace, dictionaries } = captured.dictionaries[0]
  assert.equal(namespace, 'doraemonPaperReader')
  assert.deepEqual(Object.keys(dictionaries.zh).sort(), Object.keys(dictionaries.en).sort())
  for (const [key, value] of Object.entries(dictionaries.zh)) {
    assert.equal(typeof value, 'string', key)
    assert.ok(value.trim().length > 0, key)
  }
  for (const [key, value] of Object.entries(dictionaries.en)) {
    assert.equal(typeof value, 'string', key)
    assert.ok(value.trim().length > 0, key)
  }
})

test('主界面：非对称阅读桌 + 两条并排入口，点哪条开哪页', () => {
  const homeSlot = captured.slots.find((slot) => slot.options.key === T.HOME_ID)
  const { props, opened } = makeProps()
  const tree = homeSlot.component(props)

  assert.match(tree.props.className, /dpr-homePane/)

  const question = findAll(tree, (element) => element.props.className === 'dpr-question')
  assert.equal(question.length, 1)
  assert.deepEqual(question[0].children, [T.DICT_ZH['home.question']])

  const hero = findAll(tree, (element) => String(element.props.className).includes('dpr-homeHero'))
  assert.equal(hero.length, 1, '问题与插画同属一个非对称 hero 区')
  assert.ok(
    findAll(hero[0], (element) => element.props.className === 'dpr-heroCopy').length === 1,
    '文案与插画拆成独立栏位，可独立响应窄屏',
  )
  assert.ok(
    findAll(hero[0], (element) => element.props.className === 'dpr-mascotSticker').length === 1,
    '主形象使用贴纸容器',
  )
  assert.equal(
    findAll(hero[0], (element) => element.type === 'img').length,
    1,
    '一屏一个吉祥物，不重复堆叠（界面风格 §5.1）',
  )
  const mascot = findAll(hero[0], (element) => element.type === 'img')[0]
  assert.equal(mascot.props.src, T.MASCOT_SRC)
  assert.equal(
    mascot.props.src,
    'doraemon-paper-reader/assets/mascot/action-v1/home-open-book-transparent-v1.webp',
    '插画走宿主资源路由，且必须是相对地址（不带前导斜杠，代理挂子路径时才解析得对）',
  )
  assert.ok(!/^https?:/i.test(mascot.props.src), '不许引外部 CDN')
  assert.equal(mascot.props.width, 168)
  assert.equal(mascot.props.height, 168)
  assert.ok(mascot.props.alt.length > 0, '插画必须带 alt（§8）')

  const cards = findAll(tree, (element) => element.props.className === 'dpr-card')
  assert.equal(cards.length, 2, '两条入口')
  assert.equal(findAll(tree, (element) => element.props.className === 'dpr-paths').length, 1)
  for (const card of cards) assert.equal(card.type, 'button', '入口是按钮：键盘也能用')
  assert.equal(
    cards.map((card) => findAll(card, (element) => element.props.className === 'dpr-cardIndex')[0].children[0]).join(','),
    '01,02',
    '入口保留样张中的序号',
  )

  const titles = cards.map((card) => findAll(card, (element) => element.props.className === 'dpr-cardTitle')[0].children[0])
  assert.deepEqual(titles, [T.DICT_ZH['path.file.title'], T.DICT_ZH['path.lookup.title']])
  assert.deepEqual(titles, ['PDF 文件', '信息查询'])

  cards[0].props.onClick()
  cards[1].props.onClick()
  assert.deepEqual(
    opened.map((entry) => entry.kind),
    ['doraemon-paper-file', 'doraemon-paper-lookup'],
  )

  const surveyCards = findAll(tree, (element) => element.props.className === 'dpr-surveyCard')
  assert.equal(surveyCards.length, 1, '多篇综述是第三条入口，且与两条单篇入口分开')
  assert.deepEqual(
    findAll(surveyCards[0], (element) => element.props.className === 'dpr-cardTitle')[0].children,
    [T.DICT_ZH['home.surveyTitle']],
  )
  assert.equal(surveyCards[0].type, 'button')
  surveyCards[0].props.onClick()
  assert.equal(opened.at(-1).kind, T.SURVEY_KIND)

  const maintenance = findAll(tree, (element) => element.props.className === 'dpr-maintenanceBtn')
  assert.equal(maintenance.length, 1)
  assert.deepEqual(maintenance[0].children, ['环境与存储'])
  const dialog = T.MaintenanceDialog({ onClose: () => {} })
  assert.match(collectText(dialog).join(' '), /运行环境与存储/)
  assert.match(collectText(dialog).join(' '), /正在统计/)

  const leftovers = collectText(tree).filter(
    (text) =>
      text === 'home.question' ||
      text.startsWith('path.') ||
      text.startsWith('survey.') ||
      text.startsWith('home.survey'),
  )
  assert.deepEqual(leftovers, [], '译文里不许漏出字典键（漏键等于文案缺失）')
})

test('入口图标：像素稿按整数倍放大、坐标落在网格内、颜色只来自实测色板', () => {
  const homeSlot = captured.slots.find((slot) => slot.options.key === T.HOME_ID)
  const { props } = makeProps()
  const tree = homeSlot.component(props)

  const svgs = findAll(tree, (element) => element.type === 'svg')
  assert.equal(svgs.length, 2, '只有两张入口卡各带一枚图标')
  const palette = new Set(Object.values(T.PALETTE))
  for (const svg of svgs) {
    const [width, height] = svg.props.viewBox.split(' ').slice(2).map(Number)
    assert.ok(Number.isInteger(svg.props.width) && Number.isInteger(svg.props.height), '宽高必须是整数像素')
    assert.equal(svg.props.width % width, 0, '必须是整数倍缩放（§3）')
    assert.equal(svg.props.height % height, 0, '必须是整数倍缩放（§3）')
    assert.equal(svg.props.role, 'img')
    assert.ok(svg.props['aria-label'].length > 0, '插画必须带 alt（§8）')
    assert.equal(svg.props.shapeRendering, 'crispEdges')
    for (const rect of svg.children) {
      assert.ok(Number.isInteger(rect.props.x) && Number.isInteger(rect.props.y))
      assert.ok(rect.props.x >= 0 && rect.props.y >= 0)
      assert.ok(rect.props.x + rect.props.width <= width, '像素不许越出网格')
      assert.ok(rect.props.y + rect.props.height <= height, '像素不许越出网格')
      assert.ok(palette.has(rect.props.fill), `颜色必须来自实测色板：${rect.props.fill}`)
    }
  }
})

test('对照 store：打开时换 runId、mode/jobIds 收敛，关闭只收起视图', () => {
  const store = T.createComparisonStore()
  const first = store.getSnapshot()
  store.open({ mode: 'survey', jobIds: ['job-aaaaaaaa', 'job-bbbbbbbb', 'job-aaaaaaaa'] })
  const opened = store.getSnapshot()
  assert.equal(opened.open, true)
  assert.equal(opened.mode, 'survey')
  assert.deepEqual(opened.jobIds, ['job-aaaaaaaa', 'job-bbbbbbbb'])
  assert.ok(opened.runId > first.runId)
  store.patch({ table: { fields: [] } })
  assert.equal(store.getSnapshot().table.fields.length, 0)
  store.close()
  assert.equal(store.getSnapshot().open, false)
  assert.equal(store.getSnapshot().jobIds.length, 2, '关闭不丢选择，方便再次打开')
})

test('对照视图：全宽 overlay 已接线，阅读页能从引用处打开双篇对照', async () => {
  const source = await readFile(CLIENT_FILE, 'utf8')
  assert.match(source, /ctx\.slots\.inject\('shell\.overlay'/)
  assert.match(source, /function CompareOverlay/)
  assert.match(source, /comparisonStore\.open\(\{\s*mode: 'citation'/)
  assert.match(source, /fromCitation \? \{ jobId, fromCitation \}/)
  assert.match(source, /SCROLL_STORAGE_PREFIX/)
  assert.match(source, /pointer-events:auto/)
  assert.match(source, /dpr-comparePanel/)
})

test('综述选择页：空库时给出可读空态，不伪造论文行', () => {
  const surveySlot = captured.slots.find((slot) => slot.options.key === T.SURVEY_ID)
  assert.ok(surveySlot, '综述选择页必须注册正文')
  const { props } = makeProps()
  const tree = surveySlot.component(props)
  const notes = findAll(tree, (element) => element.props.className === 'dpr-note')
  assert.ok(notes.some((note) => collectText(note).includes(T.DICT_ZH['survey.empty'])))
  const emptyArt = findAll(
    tree,
    (element) => element.type === 'img' && element.props.src === T.MASCOT_ASSETS.stackBooks,
  )
  assert.equal(emptyArt.length, 1, '空论文库使用托书插画，有列表时不堆叠吉祥物')
  const start = findAll(tree, (element) => element.props.className === 'dpr-primary')[0]
  assert.equal(start.props.disabled, true, '少于两篇时开始按钮不可用')
})

test('对照 overlay：关闭时不渲染；打开时是全宽对话框并显示加载态', () => {
  const component = T.CompareOverlay
  const closedTree = component({ t: tZh, submitDraft: async () => {}, openReader: () => {} })
  assert.equal(closedTree, null)

  T.comparisonStore.open({ mode: 'survey', jobIds: ['job-aaaaaaaa', 'job-bbbbbbbb'] })
  const tree = component({ t: tZh, submitDraft: async () => {}, openReader: () => {} })
  const panels = findAll(tree, (element) => element.props.className === 'dpr-comparePanel')
  assert.equal(panels.length, 1)
  assert.equal(panels[0].props.role, 'dialog')
  assert.equal(panels[0].props['aria-modal'], true)
  assert.ok(collectText(tree).includes(T.DICT_ZH['compare.loading']))
  T.comparisonStore.close()
})

test('对照产物：结构图只用真实计数，逻辑图从七字段表抽取', () => {
  const digests = [
    { jobId: 'job-aaaaaaaa', title: 'A', counts: { figures: 2, tables: 1, equations: 0, references: 9 } },
    { jobId: 'job-bbbbbbbb', title: 'B', counts: { figures: 5, tables: 3, equations: 2, references: 20 } },
  ]
  const structure = T.buildStructureArtifact(digests)
  assert.equal(structure.type, 'chart')
  assert.deepEqual(structure.payload.series[1], {
    jobId: 'job-bbbbbbbb',
    title: 'B',
    figures: 5,
    tables: 3,
    equations: 2,
    references: 20,
  })

  const table = {
    fields: [
      { key: 'question', cells: [{ text: 'Q A', blockIds: ['a1'], grounded: true }, { text: 'Q B', blockIds: ['b1'], grounded: true }] },
      { key: 'method', cells: [{ text: 'M A', blockIds: ['a2'], grounded: true }, { text: 'M B', blockIds: [], grounded: false }] },
      { key: 'result', cells: [{ text: 'R A', blockIds: ['a3'], grounded: true }, { text: 'R B', blockIds: ['b3'], grounded: true }] },
      { key: 'limitation', cells: [{ text: '未找到', blockIds: [], grounded: false, missing: true }, { text: 'L B', blockIds: ['b4'], grounded: true }] },
    ],
  }
  const logic = T.buildLogicArtifact(table, digests)
  assert.equal(logic.type, 'diagram')
  assert.equal(logic.payload.papers[0].question.text, 'Q A')
  assert.equal(logic.payload.papers[1].method.text, 'M B')
  assert.equal(logic.payload.papers[0].limitation.text, '未找到')
  assert.match(String(T.CompareArtifactWindow), /dpr-cmpConceptNode|dpr-cmpVersionSide|dpr-cmpPaperVersion/)
})

test('术语查词卡：只解释语境，不出现收藏、生词本或学习记录', () => {
  const tree = T.TermLookupCard({
    state: {
      status: 'ready',
      term: 'NFC',
      rect: { left: 100, bottom: 100 },
      result: {
        lookup: {
          term: 'NFC',
          kind: 'acronym',
          expanded: 'Near Field Communication',
          contextMeaning: '本文用于设备的数据通信。',
          generalMeaning: '近场通信',
          roleInSentence: '作 communication 的方式状语。',
          confidence: 'high',
          sentence: 'The Smart Sticker uses NFC for communication.',
          warnings: [],
          source: 'model-context',
          locator: { blockId: 'b0027', page: 9, section: 'Methods' },
        },
      },
    },
    onClose: () => {},
    onRetry: () => {},
    onLocate: () => {},
  })
  const text = collectText(tree).join(' ')
  assert.match(text, /论文术语/)
  assert.match(text, /Near Field Communication/)
  assert.match(text, /本文用于设备的数据通信/)
  assert.match(text, /定位原段/)
  assert.doesNotMatch(text, /生词本|收藏|掌握度|背诵/)
  assert.match(String(T.ReaderBody), /term-lookup/)
  assert.match(String(T.ReaderBody), /查词/)
  assert.match(String(T.PaperPane), /term-lookup/)
  assert.match(String(T.PaperPane), /查词/)
})

test('覆盖度图：按七字段表的真实定位状态计数', () => {
  const digests = [
    { jobId: 'a', title: 'A' },
    { jobId: 'b', title: 'B' },
  ]
  const table = {
    fields: [
      {
        key: 'q',
        cells: [
          { jobId: 'a', text: 'q', grounded: true },
          { jobId: 'b', text: 'q', grounded: true },
        ],
      },
      {
        key: 'm',
        cells: [
          { jobId: 'a', text: 'm', grounded: false },
          { jobId: 'b', text: '未找到', missing: true },
        ],
      },
    ],
  }
  const artifact = T.buildCoverageArtifact(table, digests)
  assert.equal(artifact.type, 'chart')
  assert.equal(artifact.payload.mode, 'coverage')
  assert.deepEqual(
    artifact.payload.series.map((item) => [item.grounded, item.missing, item.ungrounded]),
    [
      [1, 0, 1],
      [1, 1, 0],
    ],
  )
})

test('工作台 Markdown：标题、粗体与表格渲染成元素', () => {
  const tree = {
    type: 'root',
    props: {},
    children: T.renderMarkdown('# 结论\n\n这是**重点**。\n\n| 字段 | 值 |\n|---|---|\n| 方法 | 对比 |'),
  }
  assert.equal(findAll(tree, (element) => element.type === 'h3').length, 1)
  assert.equal(findAll(tree, (element) => element.type === 'strong').length, 1)
  assert.equal(findAll(tree, (element) => element.type === 'table').length, 1)
  assert.equal(findAll(tree, (element) => element.type === 'td').length, 2)
})

test('对照对话缓存键：论文顺序无关，模式与引用位置会换键', () => {
  const one = T.compareChatKey(['job-aaaaaaaa', 'job-bbbbbbbb'], 'survey')
  const two = T.compareChatKey(['job-bbbbbbbb', 'job-aaaaaaaa'], 'survey')
  assert.equal(one, two)
  assert.notEqual(one, T.compareChatKey(['job-aaaaaaaa', 'job-bbbbbbbb'], 'citation'))
  assert.notEqual(
    one,
    T.compareChatKey(['job-aaaaaaaa', 'job-bbbbbbbb'], 'citation', { blockId: 'a101' }),
  )
})

test('对照表导出：Markdown 表头、blockId 与管道转义', () => {
  const markdown = T.tableToMarkdown({
    fields: [
      {
        label: '研究问题',
        cells: [
          { title: 'A|B', text: 'x|y', blockIds: ['a1'], grounded: true },
          { title: 'B', text: 'z', blockIds: [], grounded: false },
        ],
      },
    ],
  })
  assert.match(markdown, /\| 字段 \| P1 A\\\|B \| P2 B \|/)
  assert.match(markdown, /x\\\|y \(a1\)/)
  assert.match(markdown, /\| 研究问题 \|/)
})

test('对照表人工修订：叠加到单元格但不改原表', () => {
  const table = {
    fields: [
      {
        key: 'question',
        label: '研究问题',
        cells: [
          { jobId: 'a', text: '原文 A', blockIds: ['a1'], grounded: true },
          { jobId: 'b', text: '原文 B', blockIds: [], grounded: false },
        ],
      },
    ],
  }
  const edited = T.applyTableEdits(table, { 'question|a': '人工修订 A' })
  assert.equal(edited.fields[0].cells[0].text, '人工修订 A')
  assert.equal(edited.fields[0].cells[0].edited, true)
  assert.equal(edited.fields[0].cells[1].text, '原文 B')
  assert.equal(table.fields[0].cells[0].text, '原文 A', '原表不能被就地改掉')
})

test('对照报告：把论文、表格、覆盖度、批注、对话与引用结论装进 Markdown', () => {
  const report = T.buildCompareReport({
    mode: 'survey',
    digests: [
      { jobId: 'a', title: 'Paper A', year: 2024, doi: '10.1/a' },
      { jobId: 'b', title: 'Paper B', year: 2025, doi: '' },
    ],
    table: {
      fields: [
        {
          key: 'q',
          label: '研究问题',
          cells: [
            { jobId: 'a', title: 'Paper A', text: 'Q A', blockIds: ['a1'], grounded: true },
            { jobId: 'b', title: 'Paper B', text: '未找到', blockIds: [], grounded: false, missing: true },
          ],
        },
      ],
    },
    annotations: [
      {
        id: 'n1',
        jobId: 'a',
        question: '能复用吗？',
        context: { paper: { title: 'Paper A' } },
        segments: [{ page: 2, blockId: 'a1', section: 'Methods', quote: '原文片段' }],
      },
      { id: 'n2', jobId: 'x', question: '别的论文', segments: [] },
    ],
    messages: [
      { role: 'user', content: '对比一下' },
      { role: 'assistant', content: '结论如下' },
    ],
    citation: { label: '证据不足', claim: 'A 主张', gap: '缺证据' },
  })
  assert.match(report, /# 论文对照报告/)
  assert.match(report, /## 七字段对照表/)
  assert.match(report, /## 证据覆盖度/)
  assert.match(report, /## 批注/)
  assert.match(report, /能复用吗/)
  assert.doesNotMatch(report, /别的论文/)
  assert.match(report, /## 工作台对话/)
  assert.match(report, /陛下/)
  assert.match(report, /## 引用支持关系/)
  assert.match(report, /证据不足/)
})

test('32 列密集表：Pdfium 文本行确定性拆成 32 列', () => {
  const rows = T.parseRotatedTableText(
    '32412 S. Typhimurium CT 2003 Chicken A - - Su T Ti - - Ag - - - - - 1 2 3 4 5 6 7 8 9 - 11 12 8.4 x 10-6',
  )
  assert.equal(rows.length, 3, '两行表头 + 一行数据')
  assert.equal(rows[2].cells.length, 32)
  assert.equal(rows[2].cells[0], '32412')
  assert.equal(rows[2].cells[4], '鸡肉')
  assert.equal(rows[2].cells[31], '8.4 x 10-6')
})

test('路径页：PDF 入口可选取/拖入，查询页仍是空态 + 三条打算 + 回主界面', () => {
  for (const pathSpec of T.PATHS) {
    const slot = captured.slots.find((entry) => entry.options.key === T.PATH_ID_PREFIX + pathSpec.id)
    assert.equal(typeof slot.options.inject, 'function', '路径页靠注册期注入拿到自己那条路的文案')
    const injected = slot.options.inject()
    assert.equal(injected.path.kind, pathSpec.kind)
    if (pathSpec.id === 'file') {
      assert.equal(slot.options.keepMounted, true, 'PDF 入口保持挂载，任务状态不因切页签丢失')
      const { props, opened } = makeProps(injected)
      const tree = slot.component(props)
      const fileInput = findAll(tree, (element) => element.type === 'input' && element.props.type === 'file')[0]
      assert.ok(fileInput, 'PDF 入口必须有文件选择 input')
      assert.equal(fileInput.props.accept, 'application/pdf,.pdf')
      const start = findAll(tree, (element) => element.props.className === 'dpr-primary')[0]
      assert.equal(start.children[0], T.DICT_ZH['import.start'])
      assert.equal(start.children[0], '大肥鱼给朕速速抄写！！！')
      const drop = findAll(tree, (element) => element.props.className?.startsWith('dpr-drop'))[0]
      assert.ok(drop, '拖入区域必须存在')
      const items = findAll(tree, (element) => element.props.className === 'dpr-todoItem')
      assert.equal(items.length, 3)
      assert.equal(findAll(tree, (element) => element.props.className === 'dpr-pageTopbar').length, 1)
      assert.equal(findAll(tree, (element) => element.props.className === 'dpr-stepper').length, 1)
      const back = findAll(tree, (element) => String(element.props.className).includes('dpr-back'))[0]
      back.props.onClick()
      assert.deepEqual(opened, [{ kind: T.HOME_KIND, options: { replaceTab: true } }])
      continue
    }
    const { props, opened } = makeProps(injected)
    const tree = slot.component(props)

    if (pathSpec.id === 'lookup') {
      const heading = findAll(tree, (element) => element.props.className === 'dpr-question')
      assert.equal(heading[0].children[0], '陛下给个线索，小的我去找论文')
      const inputs = findAll(tree, (element) => element.type === 'input')
      assert.ok(inputs.length >= 6, '查询页要有多字段可选表单')
      const modes = findAll(tree, (element) => element.props.className === 'dpr-lookupMode')
      assert.equal(modes.length, 1)
      assert.equal(modes[0].children.length, 2, '正式版 / OA 版两个选择')
      const back = findAll(tree, (element) => element.props.className === 'dpr-back')[0]
      back.props.onClick()
      assert.deepEqual(opened, [{ kind: T.HOME_KIND, options: { replaceTab: true } }])
      continue
    }

    const heading = findAll(tree, (element) => element.props.className === 'dpr-question')
    assert.deepEqual(heading[0].children, [T.DICT_ZH[pathSpec.headingKey]])

    const items = findAll(tree, (element) => element.props.className === 'dpr-todoItem')
    assert.equal(items.length, 3)
    const itemTexts = items.map((item) => collectText(item).join(''))
    assert.deepEqual(itemTexts, pathSpec.itemKeys.map((key) => T.DICT_ZH[key]))
    assert.equal(new Set(itemTexts).size, 3)
    assert.deepEqual(collectText(tree).filter((text) => text.startsWith('path.')), [])

    const back = findAll(tree, (element) => element.props.className === 'dpr-back')[0]
    back.props.onClick()
    assert.deepEqual(opened, [{ kind: T.HOME_KIND, options: { replaceTab: true } }])
  }
})

test('PDF 入口的纯函数：类型、大小、计时与阶段', () => {
  assert.equal(T.isPdfFile({ name: 'a.PDF', type: '' }), true)
  assert.equal(T.isPdfFile({ name: 'a.txt', type: 'text/plain' }), false)
  assert.equal(T.formatBytes(1536), '1.5 KB')
  assert.equal(T.formatDuration(65), '01:05')
  assert.equal(T.stageState({ status: 'running', stage: 'crop' }, 'read'), 'done')
  assert.equal(T.stageState({ status: 'running', stage: 'crop' }, 'crop'), 'active')
  assert.equal(T.stageState({ status: 'running', stage: 'crop' }, 'render'), 'pending')
  assert.equal(T.stageState({ status: 'done', stage: 'done' }, 'render'), 'done')
  assert.equal(T.stageState({ status: 'failed', stage: 'assets' }, 'assets'), 'failed')
})

test('透明状态插画：静态资产、精灵图与减少动态降级均已接线', async () => {
  assert.equal(
    T.MASCOT_SRC,
    'doraemon-paper-reader/assets/mascot/action-v1/home-open-book-transparent-v1.webp',
  )
  assert.equal(Object.keys(T.PROP_ASSETS).length, 15, '第二批小物件全部随包，但先不替换交互控件')

  const assetUrls = [
    ...Object.values(T.MASCOT_ASSETS),
    ...Object.values(T.PROP_ASSETS),
    ...Object.values(T.MASCOT_SPRITES).map((sprite) => sprite.src),
  ]
  assert.equal(new Set(assetUrls).size, assetUrls.length, '资产 URL 不重复注册')
  for (const url of assetUrls) {
    assert.ok(url.startsWith('doraemon-paper-reader/assets/'), url + ' 必须走宿主相对资源路由')
    assert.doesNotMatch(url, /^https?:/i, '不许引外部 CDN')
    const bytes = await readFile(path.join(ROOT, url.replace(/^doraemon-paper-reader\//, '')))
    assert.ok(bytes.length > 0, url + ' 随包文件不能为空')
    assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF', url + ' 必须是 WebP')
    assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WEBP', url + ' 必须是 WebP')
  }

  const loading = T.mascotSprite(tZh, 112, 'loading')
  assert.equal(loading.props.role, 'img')
  assert.match(loading.props['aria-label'], /翻动书页/)
  assert.equal(loading.props.style.width, 112)
  assert.equal(loading.props.style['--dpr-sprite-frame-5'], '-560px')
  assert.equal(loading.children[0].props.width, 672)
  assert.equal(loading.children[0].props.height, 112)
  assert.equal(loading.children[0].props.alt, '')
  assert.equal(loading.children[0].props['aria-hidden'], true)

  const success = T.mascotSprite(tZh, 112, 'success')
  assert.match(success.props['aria-label'], /任务完成/)
  assert.equal(success.props.style['--dpr-sprite-frame-4'], '-448px')
  assert.equal(success.children[0].props.width, 560)
  assert.throws(() => T.mascotSprite(tZh, 112, 'missing'), /Unknown mascot sprite/)

  const css = styleTags[0]?.textContent || ''
  assert.match(css, /\.dpr-mascot\.is-transparent/)
  assert.match(css, /dpr-mascot-loading-sprite 980ms steps\(1,end\) infinite/)
  assert.match(css, /dpr-mascot-success-sprite 1180ms steps\(1,end\) 1 forwards/)
  assert.match(css, /prefers-reduced-motion:reduce[\s\S]+dpr-mascotSprite--loading[\s\S]+translate3d\(0,0,0\)/)
  assert.match(css, /prefers-reduced-motion:reduce[\s\S]+dpr-mascotSprite--success[\s\S]+--dpr-sprite-frame-4/)
})

test('加载页按 running / done / failed 切换翻书、成功与装死状态', () => {
  const callbacks = {
    t: tZh,
    elapsed: 3,
    onOpenReader: () => {},
    onReset: () => {},
    onBack: () => {},
  }
  const runningTree = T.LoadingPanel({
    ...callbacks,
    job: { status: 'running', stage: 'read', message: '', originalName: 'paper.pdf' },
  })
  assert.equal(
    findAll(runningTree, (element) =>
      String(element.props.className).includes('dpr-mascotSprite--loading'),
    ).length,
    1,
  )
  assert.equal(
    findAll(runningTree, (element) =>
      String(element.props.className).includes('dpr-mascotSprite--loading'),
    )[0].props.style.width,
    92,
    '加载图缩到 92px，给右侧阶段文案留出安全间距',
  )

  const doneTree = T.LoadingPanel({
    ...callbacks,
    job: { status: 'done', stage: 'done', message: '', originalName: 'paper.pdf' },
  })
  assert.equal(
    findAll(doneTree, (element) =>
      String(element.props.className).includes('dpr-mascotSprite--success'),
    ).length,
    1,
  )

  const failedTree = T.LoadingPanel({
    ...callbacks,
    job: {
      status: 'failed',
      stage: 'assets',
      message: '',
      error: 'parse failed',
      originalName: 'paper.pdf',
    },
  })
  const failedArt = findAll(
    failedTree,
    (element) => element.type === 'img' && element.props.src === T.MASCOT_ASSETS.errorPlayDead,
  )
  assert.equal(failedArt.length, 1)
  assert.equal(findAll(failedTree, (element) => element.props.role === 'alert').length, 1)
})

test('B1 拖放边界与原版页查看器已接线', async () => {
  const source = await readFile(CLIENT_FILE, 'utf8')
  assert.match(source, /window\.addEventListener\('dragenter', onDragEnter, true\)/)
  assert.match(source, /window\.addEventListener\('dragover', onDragOver, true\)/)
  assert.match(source, /window\.addEventListener\('drop', onDrop, true\)/)
  assert.match(source, /dpr-sourceOverlay/)
  assert.match(source, /dpr-sourceImage/)

  const tree = T.SourcePageDialog({
    jobId: 'job-b1-test',
    page: 10,
    pageCount: 19,
    onPage: () => {},
    onClose: () => {},
    t: tZh,
  })
  assert.equal(tree.props.role, 'dialog')
  assert.match(collectText(tree).join(' '), /原版 p\.10/)
  const image = findAll(tree, (element) => element.type === 'img')[0]
  assert.ok(image)
  assert.equal(
    image.props.src,
    'doraemon-paper-reader/api/jobs/job-b1-test/source-pages/page-10.png',
  )
  assert.match(image.props.alt, /原版 p\.10/)
})

test('问答题上下文包：标题/标识符/版本/页码/原文/前后文/图表与 brief', () => {
  const doc = {
    meta: {
      title: 'Test paper',
      doi: '10.1/abc',
      arxivId: '2401.00001',
      abstract: 'Short abstract',
      brief: {
        abstract: 'Brief abstract',
        sections: [{ heading: '1. Intro', page: 1, gist: 'Gist' }],
        figures: [{ label: 'Figure 1', page: 2, caption: 'Caption' }],
        referenceCount: 3,
      },
    },
    version: { kind: 'preprint', label: 'arXiv v1', source: 'arXiv', license: 'CC BY', sha256: 'a'.repeat(64) },
    blocks: [
      { id: 'b0001', type: 'paragraph', page: 2, section: '1. Intro', text: 'before quote after' },
      { id: 'b0002', type: 'figure', page: 2, caption: 'Figure caption', label: 'Figure 1' },
    ],
  }
  const packet = T.buildContextPacket(
    doc,
    { quote: 'quote', before: 'before ', after: ' after', page: 2, blockId: 'b0001', section: '1. Intro' },
    'job1',
    'sess1',
  )
  assert.equal(packet.paper.title, 'Test paper')
  assert.equal(packet.paper.doi, '10.1/abc')
  assert.equal(packet.paper.arxiv, '2401.00001')
  assert.equal(packet.version.kind, 'preprint')
  assert.equal(packet.locator.page, 2)
  assert.equal(packet.selection.quote, 'quote')
  assert.equal(packet.nearbyAssets[0].caption, 'Figure caption')
  assert.equal(packet.brief.abstract, 'Brief abstract')
  assert.equal(
    packet.citation,
    '[p.2](dsh-resource://doraemon-paper/job1/b0001)',
  )
  assert.equal(packet.citationPath, 'work/doraemon-paper-cites/job1/b0001.dprcite')
  assert.equal(packet.citationDeepLink, 'dsh-resource://doraemon-paper/job1/b0001')
})

test('引用地址解析：jobId / blockId', () => {
  assert.deepEqual(T.parseReaderAddress('dsh-resource://doraemon-paper/job1/b0001'), {
    jobId: 'job1',
    blockId: 'b0001',
  })
  assert.deepEqual(
    T.parseReaderAddress(
      'dsh-resource://file/session/sess1/work/doraemon-paper-cites/job1/b0001.dprcite',
    ),
    { jobId: 'job1', blockId: 'b0001' },
  )
  assert.equal(T.parseReaderAddress('https://example.com'), null)
  assert.equal(T.parseReaderAddress('dsh-resource://other/job1/b0001'), null)
})

test('批注草稿：新增、改问题、标记发送、按段落删除', () => {
  const item = T.annotationStore.add({
    jobId: 'job-test',
    question: '原问题',
    sent: false,
    segments: [{ blockId: 'b0001', page: 1 }],
  })
  assert.ok(item.id.startsWith('ann-'))
  T.annotationStore.update(item.id, { question: '改后的问题' })
  assert.equal(T.annotationStore.getSnapshot().find((entry) => entry.id === item.id).question, '改后的问题')
  T.annotationStore.markSent([item.id])
  assert.equal(T.annotationStore.getSnapshot().find((entry) => entry.id === item.id).sent, true)
  T.annotationStore.removeForBlock('job-test', 'b0001')
  assert.equal(T.annotationStore.getSnapshot().some((entry) => entry.id === item.id), false)
})

test('批注存档：add 后 flush 发 PUT，loadForJob 能补回历史批注', async () => {
  const store = T.createAnnotationStore()
  const calls = []
  const oldFetch = globalThis.fetch
  const oldLocation = globalThis.window.location
  globalThis.window.location = {}
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options })
    if (options.method === 'PUT') {
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        items: [{ id: 'loaded-1', jobId: 'job-persist', question: '历史批注', sent: true, segments: [] }],
      }),
    }
  }
  try {
    const added = store.add({
      jobId: 'job-persist',
      question: '新批注',
      segments: [{ blockId: 'b0001', page: 1 }],
    })
    await store.flush('job-persist')
    assert.equal(calls[0].options.method, 'PUT')
    assert.match(calls[0].url, /jobs\/job-persist\/annotations$/)
    const body = JSON.parse(calls[0].options.body)
    assert.equal(body.items[0].id, added.id)
    assert.equal(body.items[0].sent, false)

    await store.loadForJob('job-persist')
    const snapshot = store.getSnapshot()
    assert.ok(snapshot.some((item) => item.id === added.id))
    assert.ok(snapshot.some((item) => item.id === 'loaded-1' && item.sent === true))
  } finally {
    globalThis.fetch = oldFetch
    globalThis.window.location = oldLocation
  }
})

test('像素稿：网格等宽等高、字符都在色板里', () => {
  const maps = [
    ['ICON_DOC', T.ICON_DOC, 16, 16],
    ['ICON_QUERY', T.ICON_QUERY, 16, 16],
  ]
  for (const [name, map, width, height] of maps) {
    assert.equal(map.length, height, `${name} 行数`)
    for (const row of map) {
      assert.equal(row.length, width, `${name} 每行必须正好 ${width} 列`)
      for (const char of row) assert.ok(char === '.' || char in T.PALETTE, `${name} 出现未知色标：${char}`)
    }
  }
})

test('runs()：同行同色合并成一条，覆盖的像素数与网格一致', () => {
  assert.deepEqual(T.runs(['aab']), [
    { x: 0, y: 0, w: 2, color: 'a' },
    { x: 2, y: 0, w: 1, color: 'b' },
  ])
  assert.deepEqual(T.runs(['a.a']), [
    { x: 0, y: 0, w: 1, color: 'a' },
    { x: 2, y: 0, w: 1, color: 'a' },
  ])
  assert.deepEqual(T.runs(['..']), [])
  for (const map of [T.ICON_DOC, T.ICON_QUERY]) {
    const painted = map.join('').split('').filter((char) => char !== '.').length
    const covered = T.runs(map).reduce((sum, run) => sum + run.w, 0)
    assert.equal(covered, painted, '合并不能丢像素也不能多画')
  }
})

test('引用切片：按宿主 spans 切分，不重复识别正则', () => {
  const parts = T.splitCitationText('A [3] and [4–6].', [
    { start: 2, end: 5, raw: '[3]', numbers: [3] },
    { start: 10, end: 15, raw: '[4–6]', numbers: [4, 5, 6] },
  ])
  assert.deepEqual(parts.map((part) => part.type), ['text', 'citation', 'text', 'citation', 'text'])
  assert.equal(parts[1].text, '[3]')
  assert.deepEqual(parts[3].span.numbers, [4, 5, 6])
})

test('引用关系标签：六种 stance 都有中文名', () => {
  for (const stance of ['supports', 'contrasts', 'method', 'background', 'mixed', 'unclear']) {
    assert.ok(T.citationStanceLabel(stance).length > 0)
  }
})

test('引用卡片预填：优先分析后的 metadata，并带上返回引用处参数', () => {
  const params = T.citationLookupParams({
    number: 7,
    citing: { jobId: 'job-1', blockId: 'b0003', paperTitle: 'Citing Paper' },
    reference: { raw: '7. Ref text.', title: 'Fallback title', doi: '', arxiv: '' },
    analysis: {
      metadata: {
        title: 'Cited Paper',
        authors: ['A', 'B'],
        venue: 'Journal',
        year: 2020,
        doi: '10.1/x',
        arxiv: '',
      },
    },
  })
  assert.equal(params.fields.title, 'Cited Paper')
  assert.equal(params.fields.authors, 'A, B')
  assert.equal(params.fields.doi, '10.1/x')
  assert.equal(params.fromCitation.jobId, 'job-1')
  assert.equal(params.fromCitation.blockId, 'b0003')
  assert.equal(params.fromCitation.number, 7)
})

test('引用卡片预填：预览任务完成后带上可提升的 previewJobId', () => {
  const params = T.citationLookupParams({
    resolved: { kind: 'running' },
    jobId: 'preview01',
    job: { status: 'done' },
    number: 2,
    reference: { raw: '2. Ref.' },
  })
  assert.equal(params.previewJobId, 'preview01')
  assert.equal(params.previewReady, true)
})

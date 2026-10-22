// dsh-doraemon-paper-reader —— 浏览器半区（client half）。
//
// 形态：单文件、无构建。执行本文件只做一件事：向 Client 的模块表登记 factory；
// 全部副作用（CSS 注入、组件、注册）都在 factory 里，物化时才跑。
//
// 本次登记的东西（全部落在公共前缀 doraemon.* / dsh-doraemon-paper-reader 下，见 AGENTS.md §2.3）：
//   1. 五个右侧栏页签类型（kind 前缀 doraemon-paper）：
//        doraemon-paper          主界面：问题 + 两条单篇入口 + 一条「多篇综述」通栏入口
//        doraemon-paper-file     「PDF 文件」路径页
//        doraemon-paper-lookup   「信息查询」路径页
//        doraemon-paper-survey    多篇综述的选择页（选 2–3 篇）
//        doraemon-paper-reader-doc 阅读页
//   2. `shell.overlay` 里的全宽对照视图（论文卡 / 七字段表 / 引用关系）
//   3. 引导页入口胶囊、主对话批注条
//   4. locale 命名空间 doraemonPaperReader（zh / en）
//
// 规矩（改动前先读）：docs/界面风格-v0.md（视觉语言）、AGENTS.md §2.6（UI 插件四条硬要求：
// 只用宿主主题 token、不 import 官方 client 包、明暗都正常、不替换 app root）。
// 插画（吉祥物像素稿、像素图标）用我们自己的实测色板——规范允许“插画用自己的颜色”；
// 容器与控件一律只吃 --dsw-* / --dsh-content-font-size 这类宿主 token。

window.__ModuleLoader__.load({
  id: 'dsh-doraemon-paper-reader',
  factory(require) {
    const React = require('react')

    //#region 常量：命名前缀与页签类型

    /** locale 命名空间（AGENTS.md §2.3）。 */
    const NS = 'doraemonPaperReader'
    /** 主界面页签 kind。 */
    const HOME_KIND = 'doraemon-paper'
    const LOOKUP_KIND = 'doraemon-paper-lookup'
    /** 主界面类型的实现 id，同时是正文在 sidebar.right.pane.tab 里的注册键。 */
    const HOME_ID = 'dsh-doraemon-paper-reader'
    /** 路径页的实现 id 前缀（id 全系统唯一，kind 只管分派）。 */
    const PATH_ID_PREFIX = 'dsh-doraemon-paper-reader/'
    /** 阅读页 kind / id（由抄写完成后的按钮打开，带 jobId 参数）。 */
    const READER_KIND = 'doraemon-paper-reader-doc'
    const READER_ID = PATH_ID_PREFIX + 'reader'
    /** 多篇综述的选择页；对照本身走全宽 shell.overlay。 */
    const SURVEY_KIND = 'doraemon-paper-survey'
    const SURVEY_ID = PATH_ID_PREFIX + 'survey'
    /** 全宽对照视图在 shell.overlay 里的注册 id。 */
    const COMPARE_ID = PATH_ID_PREFIX + 'compare'
    /** 最近一次抄写任务；页签关掉再回来时用它恢复后台任务。 */
    const JOB_STORAGE_KEY = 'doraemonPaperReader.lastJobId'
    const JOB_ID_RE = /^[A-Za-z0-9_-]{8,64}$/
    const LANG_STORAGE_PREFIX = 'doraemonPaperReader.langMode.'
    const SCROLL_STORAGE_PREFIX = 'doraemonPaperReader.scroll.'
    const readerScrollMemory = new Map()

    /** 跨阅读页与主对话输入区共享的批注草稿。 */
    function createAnnotationStore() {
      let items = []
      let seq = 0
      const listeners = new Set()
      const loadedJobs = new Set()
      const saveTimers = new Map()
      const emit = () => {
        const snapshot = items
        for (const listener of listeners) listener(snapshot)
      }
      const canFetch = () =>
        typeof window !== 'undefined' && Boolean(window.location) && typeof fetch === 'function'
      const snapshotForJob = (jobId) => items.filter((item) => item.jobId === jobId)
      const persist = async (jobId) => {
        if (!canFetch() || !jobId) return
        try {
          const response = await fetch(apiUrl('jobs/' + encodeURIComponent(jobId) + '/annotations'), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: snapshotForJob(jobId) }),
          })
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}))
            throw new Error(payload.error || response.statusText)
          }
        } catch (cause) {
          console.warn('[doraemon-paper-reader] 批注存档失败：', cause)
        }
      }
      const scheduleSave = (jobId) => {
        if (!jobId) return
        clearTimeout(saveTimers.get(jobId))
        saveTimers.set(
          jobId,
          setTimeout(() => {
            saveTimers.delete(jobId)
            void persist(jobId)
          }, 350),
        )
      }
      const newId = () => {
        const uuid = typeof window !== 'undefined' ? window.crypto?.randomUUID?.() : ''
        seq += 1
        return 'ann-' + (uuid || Date.now() + '-' + seq)
      }
      return {
        getSnapshot() {
          return items
        },
        snapshotForJob,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        /**
         * 从宿主读回一篇论文的批注；只补缺，不覆盖当前内存里更新的条目。
         * @param {string} jobId - 作业 id。
         * @returns {Promise<void>} 读回后触发订阅者重渲染。
         */
        async loadForJob(jobId) {
          if (!jobId || loadedJobs.has(jobId) || !canFetch()) return
          loadedJobs.add(jobId)
          try {
            const response = await fetch(apiUrl('jobs/' + encodeURIComponent(jobId) + '/annotations'), {
              cache: 'no-store',
            })
            if (!response.ok) {
              if (response.status !== 404) throw new Error(response.statusText)
              return
            }
            const payload = await response.json().catch(() => ({}))
            const loaded = Array.isArray(payload.items) ? payload.items : []
            const existing = new Set(items.map((item) => item.id))
            const additions = loaded.filter((item) => item?.id && !existing.has(item.id))
            if (additions.length > 0) {
              items = [...additions, ...items]
              emit()
            }
          } catch (cause) {
            loadedJobs.delete(jobId)
            console.warn('[doraemon-paper-reader] 批注读回失败：', cause)
          }
        },
        /** 等当前 job 的防抖保存落盘；测试用。 */
        async flush(jobId) {
          const timer = saveTimers.get(jobId)
          if (timer !== undefined) {
            clearTimeout(timer)
            saveTimers.delete(jobId)
            await persist(jobId)
          }
        },
        add(item) {
          items = [
            ...items,
            {
              ...item,
              id: newId(),
              createdAt: item.createdAt || new Date().toISOString(),
              sent: Boolean(item.sent),
            },
          ]
          emit()
          scheduleSave(items[items.length - 1].jobId)
          return items[items.length - 1]
        },
        update(id, patch) {
          const before = items.find((item) => item.id === id)
          items = items.map((item) => (item.id === id ? { ...item, ...patch } : item))
          emit()
          scheduleSave(before?.jobId)
        },
        remove(id) {
          const before = items.find((item) => item.id === id)
          items = items.filter((item) => item.id !== id)
          emit()
          scheduleSave(before?.jobId)
        },
        removeForBlock(jobId, blockId) {
          items = items.filter(
            (item) =>
              item.jobId !== jobId ||
              !item.segments.some((segment) => segment.blockId === blockId),
          )
          emit()
          scheduleSave(jobId)
        },
        markSent(ids) {
          const wanted = new Set(ids)
          const jobs = new Set(items.filter((item) => wanted.has(item.id)).map((item) => item.jobId))
          items = items.map((item) => (wanted.has(item.id) ? { ...item, sent: true } : item))
          emit()
          for (const jobId of jobs) scheduleSave(jobId)
        },
      }
    }

    const annotationStore = createAnnotationStore()

    /**
     * 全宽对照视图的共享状态：综述页、阅读页与 overlay 三处都能打开它。
     * runId 用来丢弃上一次打开留下的异步结果（换论文时旧请求可能后到）。
     */
    function compareChatKey(jobIds, mode, citing) {
      const ids = [...new Set((jobIds || []).map(String))].sort()
      return (
        'doraemonPaperReader.compareChat.' +
        ids.join('-') +
        '.' +
        mode +
        (citing?.blockId ? '.' + String(citing.blockId) : '')
      )
    }

    function loadCompareChat(key) {
      try {
        const raw = window.localStorage?.getItem(key)
        const list = raw ? JSON.parse(raw) : []
        return Array.isArray(list)
          ? list
              .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
              .slice(-40)
          : []
      } catch {
        return []
      }
    }

    function saveCompareChat(key, messages) {
      try {
        window.localStorage?.setItem(key, JSON.stringify((messages || []).slice(-40)))
      } catch {
        // 隐私模式/存储不可用时，当前会话内仍可继续。
      }
    }

    function createComparisonStore() {
      let runId = 0
      let state = {
        open: false,
        runId,
        key: '',
        mode: 'survey',
        jobIds: [],
        citing: null,
        digests: [],
        digestState: 'idle',
        table: null,
        tableEdits: {},
        tableState: 'idle',
        citation: null,
        citationState: 'idle',
        messages: [],
        chatState: 'idle',
        chatError: '',
        artifacts: [],
        openArtifacts: [],
        activeArtifact: '',
        artListOpen: false,
        tab: 'chat',
        error: '',
        notice: '',
      }
      const listeners = new Set()
      const emit = () => {
        for (const listener of listeners) listener(state)
      }
      return {
        getSnapshot() {
          return state
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        open(patch) {
          runId += 1
          const mode =
            patch?.mode === 'citation' ? 'citation' : patch?.mode === 'version' ? 'version' : 'survey'
          const jobIds = [...new Set((patch?.jobIds || []).map(String).filter(Boolean))]
          const key = compareChatKey(jobIds, mode, patch?.citing)
          const same = state.key === key
          state = {
            open: true,
            runId,
            key,
            mode,
            jobIds,
            citing: patch?.citing || null,
            digests: [],
            digestState: 'loading',
            table: null,
            tableEdits: loadTableEdits(key),
            tableState: 'idle',
            citation: null,
            citationState: 'idle',
            messages: same ? state.messages : loadCompareChat(key),
            chatState: 'idle',
            chatError: '',
            artifacts: same ? state.artifacts : [],
            openArtifacts: same ? state.openArtifacts : [],
            activeArtifact: same ? state.activeArtifact : '',
            artListOpen: false,
            tab: same ? state.tab : 'chat',
            error: '',
            notice: '',
          }
          emit()
        },
        close() {
          state = { ...state, open: false, notice: '' }
          emit()
        },
        patch(next) {
          state = { ...state, ...next }
          emit()
        },
        appendMessage(message) {
          const messages = [...state.messages, message].slice(-40)
          state = { ...state, messages }
          saveCompareChat(state.key, messages)
          emit()
        },
        clearChat() {
          state = { ...state, messages: [], chatError: '' }
          saveCompareChat(state.key, [])
          emit()
        },
        addArtifact(artifact) {
          if (!artifact?.id) return
          const others = state.artifacts.filter((item) => item.id !== artifact.id)
          state = {
            ...state,
            artifacts: [...others, artifact],
            openArtifacts: [...new Set([...state.openArtifacts, artifact.id])],
            activeArtifact: artifact.id,
            artListOpen: false,
          }
          emit()
        },
        editTableCell(fieldKey, jobId, text) {
          const editKey = String(fieldKey) + '|' + String(jobId)
          const tableEdits = { ...state.tableEdits, [editKey]: String(text ?? '') }
          const table = state.table ? applyTableEdits(state.table, tableEdits) : state.table
          const artifacts = state.artifacts.map((item) =>
            item.id === 'table' ? { ...item, payload: table } : item,
          )
          state = { ...state, tableEdits, table, artifacts }
          try {
            window.localStorage?.setItem(tableEditStorageKey(state.key), JSON.stringify(tableEdits))
          } catch {
            // 存储不可用时只在当前会话生效。
          }
          emit()
        },
        openArtifact(id) {
          const wanted = String(id || '')
          if (!state.artifacts.some((item) => item.id === wanted)) return
          state = {
            ...state,
            openArtifacts: [...new Set([...state.openArtifacts, wanted])],
            activeArtifact: wanted,
            artListOpen: false,
          }
          emit()
        },
        closeArtifact(id) {
          const wanted = String(id || state.activeArtifact || '')
          const openArtifacts = state.openArtifacts.filter((item) => item !== wanted)
          state = {
            ...state,
            openArtifacts,
            activeArtifact: openArtifacts[openArtifacts.length - 1] || '',
          }
          emit()
        },
        toggleArtList() {
          state = { ...state, artListOpen: !state.artListOpen }
          emit()
        },
        setTab(tab) {
          state = { ...state, tab: tab === 'notes' ? 'notes' : 'chat' }
          emit()
        },
      }
    }

    const comparisonStore = createComparisonStore()

    //#endregion

    //#region 样式：按宿主的 CSS 注入约定挂一次，随模块记录一起回收

    const CSS = `
.dpr-pane{flex:1 1 auto;min-width:0;min-height:0;overflow:auto;box-sizing:border-box;
  padding:24px 20px 28px;display:flex;flex-direction:column;align-items:center}
.dpr-col{width:100%;max-width:440px;display:flex;flex-direction:column;gap:18px}
.dpr-hero{display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center}
.dpr-mascot{display:block;border-radius:var(--dsw-radius-lg);border:1px solid var(--dsw-alias-border-l2)}
.dpr-question{margin:0;font-size:calc(var(--dsh-content-font-size,14px) + 6px);line-height:1.35;
  font-weight:600;color:var(--dsw-alias-label-primary);text-wrap:balance}
.dpr-sub{margin:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5;
  color:var(--dsw-alias-label-secondary)}
.dpr-paths{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:stretch}
.dpr-card{display:flex;flex-direction:column;align-items:center;gap:8px;min-width:0;
  padding:16px 12px;text-align:center;font:inherit;color:inherit;cursor:pointer;
  background:var(--dsw-alias-settings-card-fill);border:1px solid var(--dsw-alias-settings-card-stroke);
  border-radius:var(--dsw-radius-md)}
.dpr-card:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}
.dpr-card:active{background:var(--dsw-alias-interactive-bg-active)}
.dpr-card:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dpr-cardArt{display:block}
.dpr-cardTitle{font-size:var(--dsh-content-font-size,14px);line-height:1.4;font-weight:600;
  color:var(--dsw-alias-label-primary)}
.dpr-cardDesc{font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5;
  color:var(--dsw-alias-label-secondary)}
.dpr-cardGo{margin-top:auto;padding-top:2px;font-size:var(--dsh-content-font-size-secondary,13px);
  line-height:1.4;color:var(--dsw-alias-label-tertiary)}
.dpr-note{margin:0;text-align:center;font-size:var(--dsh-content-font-size-secondary,13px);
  line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dpr-library{display:flex;flex-direction:column;gap:7px;padding-top:13px;
  border-top:1px solid var(--dsw-alias-border-l2)}
.dpr-libraryHead{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dpr-libraryTitle{font-size:var(--dsh-content-font-size-secondary,13px);font-weight:650;
  color:var(--dsw-alias-label-primary)}
.dpr-libraryCount{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dpr-libraryRefresh{margin-left:auto;padding:2px 7px;font:inherit;font-size:11px;
  color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid var(--dsw-alias-border-l2);
  border-radius:999px;cursor:pointer}
.dpr-libraryRefresh:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}
.dpr-libraryList{display:flex;flex-direction:column;gap:5px;max-height:210px;overflow:auto}
.dpr-libraryItem{display:flex;flex-direction:column;gap:2px;min-width:0;padding:7px 9px;text-align:left;
  font:inherit;color:inherit;cursor:pointer;background:var(--dsw-alias-settings-card-fill);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dpr-libraryItem:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}
.dpr-libraryName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:var(--dsh-content-font-size-secondary,13px);font-weight:600;color:var(--dsw-alias-label-primary)}
.dpr-libraryMeta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dpr-maintenanceBtn{align-self:flex-end;margin-top:12px;padding:4px 9px;font:inherit;font-size:11px;
  cursor:pointer;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dpr-maintenanceBtn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3)}
.dpr-maintenanceOverlay{position:fixed;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;
  padding:16px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 26%,transparent)}
.dpr-maintenanceCard{width:min(620px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;
  display:flex;flex-direction:column;gap:12px;padding:16px;background:var(--dsw-alias-bg-base);
  border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);
  box-shadow:0 18px 52px color-mix(in srgb,var(--dsw-alias-label-primary) 24%,transparent)}
.dpr-maintenanceHead{display:flex;align-items:flex-start;gap:10px}
.dpr-maintenanceHead h3{margin:0;flex:1;font-size:16px;color:var(--dsw-alias-label-primary)}
.dpr-maintenanceHead button{padding:0 7px;font:inherit;font-size:18px;cursor:pointer;
  color:var(--dsw-alias-label-tertiary);background:transparent;border:0}
.dpr-maintenanceGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.dpr-maintenanceStat{padding:9px 10px;background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dpr-maintenanceStat b{display:block;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dpr-maintenanceStat span{display:block;margin-top:3px;font-size:13px;color:var(--dsw-alias-label-primary);
  overflow-wrap:anywhere}
.dpr-maintenanceActions{display:flex;gap:7px;flex-wrap:wrap}
.dpr-maintenanceActions button{padding:6px 9px;font:inherit;font-size:12px;cursor:pointer;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dpr-maintenanceActions button:disabled{opacity:.55;cursor:wait}
.dpr-maintenanceNote{margin:0;font-size:11px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
@media (max-width:640px){.dpr-maintenanceGrid{grid-template-columns:1fr}}
.dpr-lookup{display:flex;flex-direction:column;gap:10px}
.dpr-lookupMode{display:flex;flex-wrap:wrap;gap:6px}
.dpr-lookupMode button{padding:6px 9px;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);
  background:var(--dsw-alias-settings-card-fill);border:1px solid var(--dsw-alias-border-l2);
  border-radius:999px;cursor:pointer}
.dpr-lookupMode button.is-active{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary);
  background:var(--dsw-alias-interactive-bg-hover)}
.dpr-lookupGrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.dpr-lookupField{display:flex;flex-direction:column;gap:4px;min-width:0}
.dpr-lookupField span{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dpr-lookupField input{width:100%;box-sizing:border-box;padding:7px 8px;font:inherit;font-size:13px;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dpr-lookupField input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dpr-lookupHint{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dpr-metaCard{display:flex;flex-direction:column;gap:7px;padding:11px;text-align:left;
  background:var(--dsw-alias-settings-card-fill);border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-md)}
.dpr-metaTitle{margin:0;font-size:14px;line-height:1.35;font-weight:650;color:var(--dsw-alias-label-primary)}
.dpr-metaLine{font-size:12px;line-height:1.45;color:var(--dsw-alias-label-secondary)}
.dpr-metaAbstract{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dpr-candidate{display:flex;flex-direction:column;gap:3px;padding:8px;text-align:left;font:inherit;
  background:var(--dsw-alias-settings-card-fill);border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-sm);cursor:pointer}
.dpr-candidate:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}
.dpr-candidateTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dpr-candidateMeta{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dpr-todo{display:flex;flex-direction:column;gap:10px;margin:0;padding:0;list-style:none}
.dpr-todoItem{display:flex;gap:8px;align-items:flex-start;
  font-size:var(--dsh-content-font-size,14px);line-height:1.55;color:var(--dsw-alias-label-secondary)}
.dpr-bullet{flex:none;margin-top:7px;width:6px;height:6px;background:#428AC7;border:1px solid #10101A}
.dpr-back{align-self:center;display:inline-flex;align-items:center;padding:7px 14px;font:inherit;
  font-size:var(--dsh-content-font-size-secondary,13px);color:var(--dsw-alias-label-primary);
  cursor:pointer;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l3);
  border-radius:var(--dsw-radius-sm)}
.dpr-back:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dpr-back:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dpr-import{display:flex;flex-direction:column;gap:14px;width:100%;max-width:440px}
.dpr-drop{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;min-height:132px;
  padding:18px;text-align:center;cursor:pointer;background:var(--dsw-alias-bg-layer-2);
  border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md)}
.dpr-drop:hover,.dpr-drop.is-over{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-brand-primary)}
.dpr-drop:focus-within{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dpr-dropTitle{font-size:var(--dsh-content-font-size,14px);font-weight:600;color:var(--dsw-alias-label-primary)}
.dpr-dropHint{font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dpr-fileInput{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);
  white-space:nowrap;border:0}
.dpr-fileMeta{font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.55;color:var(--dsw-alias-label-secondary)}
.dpr-choose{display:inline-flex;align-items:center;justify-content:center;width:100%;padding:8px 14px;font:inherit;
  font-size:var(--dsh-content-font-size-secondary,13px);color:var(--dsw-alias-label-primary);cursor:pointer;
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l3);
  border-radius:var(--dsw-radius-sm)}
.dpr-choose:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dpr-choose:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dpr-primary{display:inline-flex;align-items:center;justify-content:center;width:100%;padding:11px 14px;font:inherit;
  font-size:var(--dsh-content-font-size,14px);font-weight:600;color:var(--dsw-alias-label-primary);cursor:pointer;
  background:var(--dsw-alias-settings-card-fill);border:1px solid var(--dsw-alias-brand-primary);
  border-radius:var(--dsw-radius-sm)}
.dpr-primary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dpr-primary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dpr-primary:disabled{cursor:not-allowed;opacity:.55}
.dpr-error{display:flex;gap:8px;align-items:flex-start;padding:10px 12px;font-size:var(--dsh-content-font-size-secondary,13px);
  line-height:1.55;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm)}
.dpr-load{display:flex;flex-direction:column;gap:16px;width:100%;max-width:440px;align-items:center}
.dpr-mascotSlot{position:relative;display:flex;align-items:flex-end;justify-content:center;width:100%;min-height:190px;
  padding:12px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-lg);overflow:hidden}
.dpr-mascotSlot img{display:block;border:0;border-radius:var(--dsw-radius-md);animation:dpr-bob 2.4s ease-in-out infinite}
.dpr-slotNote{position:absolute;left:10px;right:10px;bottom:7px;text-align:center;
  font-size:11px;line-height:1.4;color:var(--dsw-alias-label-tertiary)}
@keyframes dpr-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
@media (prefers-reduced-motion: reduce){.dpr-mascotSlot img{animation:none}}
.dpr-stages{display:flex;flex-direction:column;gap:7px;width:100%;margin:0;padding:0;list-style:none}
.dpr-stage{display:flex;gap:9px;align-items:flex-start;font-size:var(--dsh-content-font-size-secondary,13px);
  line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dpr-stageDot{flex:none;width:9px;height:9px;margin-top:4px;border:1px solid var(--dsw-alias-border-l3);
  border-radius:50%;background:var(--dsw-alias-bg-layer-2)}
.dpr-stage.is-active{color:var(--dsw-alias-label-primary);font-weight:600}
.dpr-stage.is-active .dpr-stageDot{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dpr-stage.is-done{color:var(--dsw-alias-label-secondary)}
.dpr-stage.is-done .dpr-stageDot{background:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-label-secondary)}
.dpr-stage.is-failed{color:var(--dsw-alias-label-primary)}
.dpr-stage.is-failed .dpr-stageDot{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary)}
.dpr-timerRow{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:center;gap:6px;width:100%;
  font-size:var(--dsh-content-font-size-secondary,13px);color:var(--dsw-alias-label-secondary)}
.dpr-timer{font-variant-numeric:tabular-nums;font-weight:650;color:var(--dsw-alias-label-primary)}
.dpr-bgNote{font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.55;text-align:center;
  color:var(--dsw-alias-label-tertiary)}
.dpr-readerPane{position:relative;align-items:stretch;padding:0}
.dpr-reader{display:flex;flex-direction:column;min-width:0;width:100%;height:100%;overflow:auto;
  background:var(--dsw-alias-bg-layer-2)}
.dpr-readerBar{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;align-items:center;gap:8px;
  padding:9px 14px;background:var(--dsw-alias-settings-card-fill);border-bottom:1px solid var(--dsw-alias-border-l2)}
.dpr-readerBarTitle{flex:1 1 180px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:var(--dsh-content-font-size-secondary,13px);font-weight:650;color:var(--dsw-alias-label-primary)}
.dpr-langSwitch{flex:none;display:inline-flex;align-items:center;gap:5px;padding:5px 9px;border-radius:999px;
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;font-weight:650;cursor:pointer;white-space:nowrap}
.dpr-langSwitch:hover{border-color:var(--dsw-alias-link);color:var(--dsw-alias-link)}
.dpr-langSwitch.is-active{border-color:var(--dsw-alias-link);color:var(--dsw-alias-link);
  background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-layer-2))}
.dpr-langDot{width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.5}
.dpr-langSwitch.is-running .dpr-langDot{opacity:1;animation:dpr-pulse 1s ease-in-out infinite}
@keyframes dpr-pulse{50%{opacity:.25}}
.dpr-translateNote{display:flex;align-items:center;gap:6px;margin:10px 20px 0;padding:7px 9px;
  border:1px solid var(--dsw-alias-border-l2);border-left:2px solid var(--dsw-alias-link);
  border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);
  font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary)}
.dpr-readerBody{width:100%;max-width:860px;margin:0 auto;padding:20px 20px 56px;box-sizing:border-box}

/* 主界面的第三入口：多篇综述。与两条单篇入口分开成一张通栏卡，避免挤成三列。 */
.dpr-surveyCard{display:flex;flex-direction:column;gap:5px;width:100%;padding:13px 14px;text-align:left;
  font:inherit;color:inherit;cursor:pointer;background:var(--dsw-alias-settings-card-fill);
  border:1px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-md)}
.dpr-surveyCard:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}
.dpr-surveyCard:active{background:var(--dsw-alias-interactive-bg-active)}
.dpr-surveyCard:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dpr-surveyHead{display:flex;align-items:center;gap:8px}
.dpr-surveyGlyph{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;
  border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary);
  font-size:15px;font-weight:700}
.dpr-surveyList{display:flex;flex-direction:column;gap:6px;width:100%;max-height:360px;overflow:auto}
.dpr-surveyRow{display:flex;align-items:flex-start;gap:8px;padding:8px 9px;cursor:pointer;
  background:var(--dsw-alias-settings-card-fill);border:1px solid var(--dsw-alias-settings-card-stroke);
  border-radius:var(--dsw-radius-sm)}
.dpr-surveyRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dpr-surveyRow.is-selected{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dpr-surveyRow input{margin:3px 0 0;flex:none}
.dpr-surveyName{display:block;font-size:var(--dsh-content-font-size,14px);line-height:1.4;
  color:var(--dsw-alias-label-primary)}
.dpr-surveyMeta{display:block;margin-top:2px;font-size:var(--dsh-content-font-size-secondary,13px);
  line-height:1.45;color:var(--dsw-alias-label-tertiary)}

/* 全宽对照视图：shell.overlay 本身是 click-through，只有面板与遮罩接回指针事件。 */
.dpr-compareRoot{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;
  padding:16px;pointer-events:none}
.dpr-compareBackdrop{position:absolute;inset:0;pointer-events:auto;background:var(--dsw-alias-bg-mask-2)}
.dpr-comparePanel{position:relative;pointer-events:auto;display:flex;flex-direction:column;
  width:min(1480px,100%);height:min(92vh,1040px);overflow:hidden;background:var(--dsw-alias-bg-base);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);
  box-shadow:0 14px 44px color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent)}
.dpr-compareHeader{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;
  padding:13px 17px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dpr-compareKicker{display:block;font-size:11px;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary)}
.dpr-compareTitle{margin:2px 0 0;font-size:calc(var(--dsh-content-font-size,14px) + 3px);line-height:1.35;
  color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dpr-compareClose{flex:none;padding:5px 10px;font:inherit;font-size:12px;cursor:pointer;color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dpr-compareBody{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 300px}
.dpr-compareMain{min-width:0;overflow:auto;padding:14px 17px 26px;display:flex;flex-direction:column;gap:14px}
.dpr-compareSide{min-width:0;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:10px;
  border-left:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.dpr-comparePapers{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:10px}
.dpr-comparePaper{display:flex;flex-direction:column;gap:6px;min-width:0;padding:11px 12px;
  background:var(--dsw-alias-settings-card-fill);border:1px solid var(--dsw-alias-settings-card-stroke);
  border-radius:var(--dsw-radius-md)}
.dpr-comparePaper h3{margin:0;font-size:var(--dsh-content-font-size,14px);line-height:1.4;
  color:var(--dsw-alias-label-primary)}
.dpr-compareMeta{font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.45;color:var(--dsw-alias-label-tertiary)}
.dpr-compareAbstract{margin:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.55;
  color:var(--dsw-alias-label-secondary);max-height:7.8em;overflow:auto}
.dpr-compareSections{display:flex;flex-wrap:wrap;gap:4px}
.dpr-compareChip{max-width:100%;padding:3px 7px;font:inherit;font-size:11px;line-height:1.35;text-align:left;
  cursor:pointer;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dpr-compareChip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dpr-compareBlockTitle{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0;
  font-size:var(--dsh-content-font-size,14px);color:var(--dsw-alias-label-primary)}
.dpr-compareHint{margin:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5;
  color:var(--dsw-alias-label-tertiary)}
.dpr-compareActions{display:flex;flex-wrap:wrap;gap:7px;align-items:center}
.dpr-compareActions button{width:auto}
.dpr-compareTableWrap{max-width:100%;overflow:auto;border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base)}
.dpr-compareTable{width:100%;border-collapse:collapse;font-size:var(--dsh-content-font-size-secondary,13px)}
.dpr-compareTable th,.dpr-compareTable td{padding:7px 8px;text-align:left;vertical-align:top;
  border-right:1px solid var(--dsw-alias-border-l2);border-bottom:1px solid var(--dsw-alias-border-l2)}
.dpr-compareTable th{position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-primary);font-weight:600;min-width:160px}
.dpr-compareTable td{min-width:190px;color:var(--dsw-alias-label-secondary)}
.dpr-compareTable td:first-child,.dpr-compareTable th:first-child{position:sticky;left:0;z-index:2;
  min-width:96px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600}
.dpr-compareCellText{margin:0 0 5px;line-height:1.55;white-space:pre-wrap}
.dpr-cmpCellEdit{width:100%;min-height:62px;box-sizing:border-box;padding:5px 6px;font:inherit;
  font-size:11px;line-height:1.5;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);resize:vertical}
.dpr-compareCell.is-ungrounded .dpr-compareCellText{color:var(--dsw-alias-state-warn-label)}
.dpr-compareAnchors{display:flex;flex-wrap:wrap;gap:4px}
.dpr-compareAnchor{padding:2px 6px;font:inherit;font-size:11px;line-height:1.3;cursor:pointer;
  color:var(--dsw-alias-link);background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dpr-compareStats{font-size:11px;line-height:1.4;color:var(--dsw-alias-label-tertiary)}
.dpr-compareVerdict{display:flex;flex-direction:column;gap:7px;padding:11px 12px;
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-md)}
.dpr-compareVerdictLabel{align-self:flex-start;padding:3px 8px;font-size:12px;line-height:1.3;
  border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l2)}
.dpr-compareVerdictLabel.is-supports{color:var(--dsw-alias-state-success-primary)}
.dpr-compareVerdictLabel.is-conflicts{color:var(--dsw-alias-state-error-primary)}
.dpr-compareVerdictLabel.is-insufficient{color:var(--dsw-alias-state-warn-label)}
.dpr-citeQuote{margin:0;padding:9px 11px;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.6;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);
  border-left:3px solid var(--dsw-alias-brand-primary);border-radius:var(--dsw-radius-sm);white-space:pre-wrap;
  max-height:220px;overflow:auto}
.dpr-compareAsk{width:100%;min-height:76px;box-sizing:border-box;padding:7px 8px;font:inherit;font-size:13px;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);resize:vertical}
.dpr-compareSide .dpr-primary,.dpr-compareSide .dpr-back{width:100%;box-sizing:border-box}

/* —— 对照工作台 v2：两篇全文 + 右侧工作台 + 产物浮窗 —— */
.dpr-cmpHeadMain{min-width:0}
.dpr-cmpHeadActions{display:flex;align-items:center;gap:8px;flex:none}
.dpr-cmpBody{flex:1 1 auto;min-height:0;display:grid;
  grid-template-columns:minmax(0,8fr) minmax(360px,3fr)}
.dpr-cmpPapers{min-width:0;min-height:0;display:grid;grid-template-columns:1fr 1fr;gap:8px;
  padding:10px;overflow:hidden}
.dpr-cmpPaperPane{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;
  background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-md)}
.dpr-cmpPaperHead{flex:none;display:flex;flex-direction:column;gap:4px;padding:9px 11px;
  border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.dpr-cmpPaperTitleRow{display:flex;align-items:flex-start;gap:7px;min-width:0}
.dpr-cmpPaperTag{flex:none;padding:1px 6px;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-sm)}
.dpr-cmpPaperTitleRow h3{margin:0;font-size:var(--dsh-content-font-size,14px);line-height:1.4;
  color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dpr-cmpPaperVersion{flex:none;align-self:flex-start;margin-left:auto;padding:1px 6px;font-size:10px;line-height:1.6;
  color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);white-space:nowrap}
.dpr-cmpPaperVersion.is-vor{color:var(--dsw-alias-state-success-primary)}
.dpr-cmpPaperVersion.is-preprint{color:var(--dsw-alias-state-warn-label)}
.dpr-cmpPaperMeta{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-tertiary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dpr-cmpPaperActions{display:flex;gap:6px;flex-wrap:wrap}
.dpr-cmpPaperActions .dpr-back{padding:3px 7px;font-size:11px}
.dpr-cmpLangBtn{padding:3px 7px;font:inherit;font-size:11px;line-height:1.4;cursor:pointer;
  color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dpr-cmpLangBtn.is-active{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}
.dpr-cmpTransState{font-size:10px;line-height:1.4;color:var(--dsw-alias-label-tertiary);align-self:center}
.dpr-cmpSource{display:block;color:var(--dsw-alias-label-secondary)}
.dpr-cmpTarget{display:block;margin-top:4px;padding-left:7px;border-left:2px solid var(--dsw-alias-link);
  color:var(--dsw-alias-label-primary)}
.dpr-cmpMark{padding:0 1px;border-radius:2px;background:var(--dsw-alias-state-warn-tertiary);
  color:var(--dsw-alias-label-primary)}
.dpr-cmpCiteLink.dpr-cmpMarkLink{background:var(--dsw-alias-state-warn-tertiary);border-radius:2px}
.dpr-cmpPaperBody{flex:1 1 auto;min-height:0;overflow:auto;padding:10px 12px 24px;
  font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.68;color:var(--dsw-alias-label-primary)}
.dpr-cmpPaperBody h3,.dpr-cmpPaperBody h4{margin:14px 0 6px;line-height:1.4;color:var(--dsw-alias-label-primary)}
.dpr-cmpPaperBody h3{font-size:calc(var(--dsh-content-font-size,14px) + 1px)}
.dpr-cmpPaperBody h4{font-size:var(--dsh-content-font-size,14px)}
.dpr-cmpBlock{margin:0 0 10px;overflow-wrap:anywhere}
.dpr-cmpBlock.is-heading{margin-top:14px}
.dpr-cmpBlock.is-annotated{padding-left:7px;border-left:2px solid var(--dsw-alias-brand-primary)}
.dpr-cmpCiteLink{display:inline;padding:0 1px;font:inherit;line-height:inherit;cursor:pointer;
  color:var(--dsw-alias-link);background:transparent;border:0;text-decoration:underline;
  text-decoration-thickness:1px;text-underline-offset:2px}
.dpr-cmpCiteLink:hover{color:var(--dsw-alias-brand-primary)}
.dpr-cmpBlockNote{display:inline-block;margin-left:5px;padding:1px 5px;font:inherit;font-size:10px;
  cursor:pointer;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);vertical-align:super}
.dpr-cmpFigure{margin:10px 0 12px;padding:0}
.dpr-cmpFigure img{display:block;max-width:100%;height:auto;margin:0 auto;
  border-radius:var(--dsw-radius-sm);border:1px solid var(--dsw-alias-border-l2)}
.dpr-cmpFigure figcaption{margin-top:5px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary);
  text-align:left}
.dpr-cmpLatexBox{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:6px;padding:6px 7px;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-sm)}
.dpr-cmpLatex{flex:1 1 180px;min-width:0;max-height:88px;overflow:auto;white-space:pre-wrap;
  font-family:var(--dsw-font-mono,monospace);font-size:11px;line-height:1.45;color:var(--dsw-alias-label-primary)}
.dpr-cmpLatexBox .dpr-back{flex:none;padding:3px 7px;font-size:10px}
.dpr-cmpFormulaSvg{background:white;padding:6px;max-height:190px;object-fit:contain}
.dpr-cmpKatex{background:white;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-sm);overflow:auto;text-align:center;color:black}
.dpr-cmpKatex .katex{font-size:1.12em}
.dpr-cmpFormulaSource{margin-top:6px;background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dpr-cmpFormulaSource summary{padding:5px 7px;font-size:11px;cursor:pointer;
  color:var(--dsw-alias-label-secondary)}
.dpr-cmpTableTrans{margin-top:6px;background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dpr-cmpTableTrans summary{padding:5px 7px;font-size:11px;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.dpr-cmpTablePre{margin:0;max-height:180px;overflow:auto;padding:7px;font-size:10px;line-height:1.45;
  white-space:pre;color:var(--dsw-alias-label-primary);border-top:1px solid var(--dsw-alias-border-l2)}
.dpr-cmpTableGridWrap{max-height:220px;overflow:auto;border-top:1px solid var(--dsw-alias-border-l2)}
.dpr-cmpTableGrid{border-collapse:collapse;width:100%;font-size:10px}
.dpr-cmpTableGrid th,.dpr-cmpTableGrid td{padding:3px 5px;text-align:left;vertical-align:top;
  border-right:1px solid var(--dsw-alias-border-l2);border-bottom:1px solid var(--dsw-alias-border-l2);
  white-space:nowrap;color:var(--dsw-alias-label-primary)}
.dpr-cmpTableGrid th{background:var(--dsw-alias-bg-layer-2);font-weight:600}
.dpr-cmpAbstractBox{margin:0 0 12px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dpr-cmpAbstractBox h4{margin:0 0 4px}
.dpr-cmpAbstractBox p{margin:0;font-size:11px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.dpr-cmpPaneError,.dpr-cmpPaneLoading{grid-column:1 / -1;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:8px;padding:24px;color:var(--dsw-alias-label-secondary)}
.dpr-cmpSelBar{position:fixed;z-index:80;display:flex;flex-direction:column;gap:6px;width:320px;
  padding:8px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l3);
  border-radius:var(--dsw-radius-md);box-shadow:0 10px 30px color-mix(in srgb,var(--dsw-alias-label-primary) 18%,transparent)}
.dpr-cmpSelQuote{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-tertiary)}
.dpr-cmpSelBar textarea{width:100%;min-height:56px;max-height:120px;box-sizing:border-box;padding:6px 7px;
  font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);resize:vertical}
.dpr-cmpSelActions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.dpr-cmpSelActions .dpr-primary,.dpr-cmpSelActions .dpr-back{width:auto;flex:1 1 auto;padding:6px 9px;font-size:12px}
.dpr-cmpWorkspace{min-width:0;min-height:0;display:flex;flex-direction:column;
  padding-right:30px;border-left:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.dpr-cmpWorkspaceHead{flex:none;display:flex;align-items:flex-start;justify-content:space-between;gap:8px;
  padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dpr-cmpWorkspaceHead h3{margin:2px 0 0;font-size:var(--dsh-content-font-size,14px);
  color:var(--dsw-alias-label-primary)}
.dpr-cmpWorkspaceMeta{font-size:10px;line-height:1.4;color:var(--dsw-alias-label-tertiary);text-align:right}
.dpr-cmpTabs{flex:none;display:flex;gap:4px;padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dpr-cmpTabs button{padding:4px 9px;font:inherit;font-size:12px;cursor:pointer;
  color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid transparent;
  border-radius:var(--dsw-radius-sm)}
.dpr-cmpTabs button.is-active{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);
  border-color:var(--dsw-alias-border-l2)}
.dpr-cmpChatList{flex:1 1 auto;min-height:0;overflow:auto;padding:10px 11px;display:flex;flex-direction:column;gap:9px}
.dpr-cmpChatEmpty{margin:auto;text-align:center;color:var(--dsw-alias-label-secondary);
  font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.6}
.dpr-cmpMsg{display:flex;flex-direction:column;gap:3px;max-width:100%}
.dpr-cmpMsgRole{font-size:10px;color:var(--dsw-alias-label-tertiary)}
.dpr-cmpMsgBody{padding:7px 9px;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.6;
  border-radius:var(--dsw-radius-sm);white-space:normal;overflow-wrap:anywhere;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);
  border:1px solid var(--dsw-alias-border-l2)}
.dpr-cmpMsg.is-user .dpr-cmpMsgBody{background:var(--dsw-alias-bg-layer-2);
  border-color:var(--dsw-alias-border-l3);white-space:pre-wrap}
.dpr-cmpMdP{margin:0 0 7px;line-height:1.65}
.dpr-cmpMdP:last-child{margin-bottom:0}
.dpr-cmpMdH{margin:9px 0 5px;font-size:13px;line-height:1.4;color:var(--dsw-alias-label-primary)}
.dpr-cmpMdList{margin:0 0 7px;padding-left:18px}
.dpr-cmpMdList li{margin:2px 0;line-height:1.6}
.dpr-cmpMdTableWrap{max-width:100%;overflow:auto;margin:5px 0 8px;
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dpr-cmpMdTable{border-collapse:collapse;width:100%;font-size:11px}
.dpr-cmpMdTable th,.dpr-cmpMdTable td{padding:4px 6px;text-align:left;vertical-align:top;
  border-right:1px solid var(--dsw-alias-border-l2);border-bottom:1px solid var(--dsw-alias-border-l2)}
.dpr-cmpMdTable th{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}
.dpr-cmpMdCode{padding:1px 3px;font-family:var(--dsw-font-mono,monospace);font-size:.95em;
  background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-sm)}
.dpr-cmpMdQuote{margin:5px 0;padding:4px 8px;border-left:2px solid var(--dsw-alias-brand-primary);
  color:var(--dsw-alias-label-secondary)}
.dpr-cmpMdHr{border:0;border-top:1px solid var(--dsw-alias-border-l2);margin:9px 0}
.dpr-cmpCommands{flex:none;display:flex;flex-wrap:wrap;gap:4px;padding:0 10px 7px}
.dpr-cmpCommands button{padding:3px 7px;font:inherit;font-size:11px;cursor:pointer;
  color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dpr-cmpCommands button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dpr-cmpComposer{flex:none;display:flex;flex-direction:column;gap:6px;padding:0 10px 8px}
.dpr-cmpComposer textarea{width:100%;min-height:62px;max-height:150px;box-sizing:border-box;padding:7px 8px;
  font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-sm);resize:vertical}
.dpr-cmpComposer .dpr-primary{width:100%;padding:7px 10px;font-size:12px}
.dpr-cmpWorkspaceFoot{flex:none;display:flex;gap:6px;padding:0 10px 10px}
.dpr-cmpWorkspaceFoot .dpr-back{flex:1;padding:5px 8px;font-size:11px}
.dpr-cmpNotes{flex:1 1 auto;min-height:0;overflow:auto;padding:9px 10px;display:flex;flex-direction:column;gap:7px}
.dpr-cmpNoteItem{padding:8px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-sm)}
.dpr-cmpNoteMeta{font-size:10px;line-height:1.4;color:var(--dsw-alias-label-tertiary)}
.dpr-cmpNoteQuestion{margin:4px 0 3px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dpr-cmpNoteQuote{margin:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dpr-cmpNoteActions{display:flex;gap:5px;margin-top:6px}
.dpr-cmpNoteActions .dpr-back{padding:3px 7px;font-size:11px}
.dpr-cmpRail{position:absolute;right:0;top:76px;z-index:70;display:flex;flex-direction:column;align-items:flex-end;
  pointer-events:none}
.dpr-cmpRailBtn{pointer-events:auto;display:flex;flex-direction:column;align-items:center;gap:2px;
  width:30px;padding:7px 2px;font:inherit;font-size:12px;cursor:pointer;color:var(--dsw-alias-label-secondary);
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);
  border-right:0;border-radius:var(--dsw-radius-sm) 0 0 var(--dsw-radius-sm)}
.dpr-cmpRailBtn.is-open,.dpr-cmpRailBtn:hover{color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-interactive-bg-hover)}
.dpr-cmpRailLabel{font-size:9px;line-height:1.2;writing-mode:vertical-rl}
.dpr-cmpRailCount{display:inline-flex;align-items:center;justify-content:center;min-width:15px;height:15px;
  padding:0 3px;font-size:9px;border-radius:8px;background:var(--dsw-alias-bg-base);
  border:1px solid var(--dsw-alias-border-l2)}
.dpr-cmpArtList{position:absolute;right:34px;top:76px;z-index:71;width:210px;padding:7px;
  display:flex;flex-direction:column;gap:4px;background:var(--dsw-alias-bg-base);
  border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);
  box-shadow:0 10px 28px color-mix(in srgb,var(--dsw-alias-label-primary) 16%,transparent)}
.dpr-cmpArtListHead{font-size:10px;color:var(--dsw-alias-label-tertiary);padding:2px 4px 4px}
.dpr-cmpArtItem{display:flex;align-items:center;gap:7px;padding:6px 7px;font:inherit;font-size:12px;
  text-align:left;cursor:pointer;color:var(--dsw-alias-label-primary);background:transparent;
  border:1px solid transparent;border-radius:var(--dsw-radius-sm)}
.dpr-cmpArtItem:hover,.dpr-cmpArtItem.is-active{background:var(--dsw-alias-interactive-bg-hover);
  border-color:var(--dsw-alias-border-l2)}
.dpr-cmpArtIcon{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;
  font-size:12px;color:var(--dsw-alias-brand-primary)}
.dpr-cmpArtWindow{position:absolute;inset:64px 16px 16px;z-index:60;display:flex;flex-direction:column;
  background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l3);
  border-radius:var(--dsw-radius-lg);box-shadow:0 16px 46px color-mix(in srgb,var(--dsw-alias-label-primary) 20%,transparent);
  overflow:hidden;resize:both;min-width:420px;min-height:260px;max-width:calc(100% - 8px);max-height:calc(100% - 8px)}
.dpr-cmpArtHead{flex:none;display:flex;align-items:center;gap:8px;padding:9px 12px;
  border-bottom:1px solid var(--dsw-alias-border-l2);cursor:move;user-select:none}
.dpr-cmpArtHead h3{margin:0;flex:1;font-size:var(--dsh-content-font-size,14px);color:var(--dsw-alias-label-primary)}
.dpr-cmpArtActions{display:flex;gap:5px;flex:none}
.dpr-cmpArtActions .dpr-back{padding:3px 7px;font-size:10px}
.dpr-cmpArtBody{flex:1 1 auto;min-height:0;overflow:auto;padding:10px 12px 18px}
.dpr-cmpArtScroll{max-height:calc(100% - 24px);overflow:auto}
.dpr-cmpArtText{margin:0;font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.65;
  white-space:pre-wrap;color:var(--dsw-alias-label-primary)}
.dpr-cmpLogicGrid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.dpr-cmpLogicCol{min-width:0;padding:10px;background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.dpr-cmpLogicCol h3{margin:0 0 8px;font-size:13px;line-height:1.4;color:var(--dsw-alias-label-primary)}
.dpr-cmpLogicBox{padding:8px 9px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-sm)}
.dpr-cmpLogicBox.is-muted{opacity:.72}
.dpr-cmpLogicLabel{display:block;font-size:10px;color:var(--dsw-alias-label-tertiary);margin-bottom:3px}
.dpr-cmpLogicBox p{margin:0 0 4px;font-size:12px;line-height:1.55;color:var(--dsw-alias-label-primary);
  white-space:pre-wrap}
.dpr-cmpLogicArrow{text-align:center;padding:3px 0;color:var(--dsw-alias-label-tertiary)}
.dpr-cmpChartList{display:flex;flex-direction:column;gap:10px}
.dpr-cmpChartCard{padding:10px 12px;background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.dpr-cmpChartCard h3{margin:0 0 7px;font-size:13px;line-height:1.4;color:var(--dsw-alias-label-primary)}
.dpr-cmpChartRow{display:flex;align-items:center;gap:7px;margin:4px 0;font-size:11px}
.dpr-cmpChartLabel{flex:none;width:58px;color:var(--dsw-alias-label-secondary)}
.dpr-cmpChartTrack{flex:1;height:10px;background:var(--dsw-alias-bg-layer-2);border-radius:5px;overflow:hidden}
.dpr-cmpChartFill{display:block;height:100%;background:var(--dsw-alias-brand-primary);border-radius:5px}
.dpr-cmpChartValue{flex:none;width:28px;text-align:right;color:var(--dsw-alias-label-secondary)}
.dpr-cmpModelChart{display:flex;flex-direction:column;gap:10px}
.dpr-cmpModelChart .dpr-cmpChartLabel{width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dpr-cmpLineChart{display:block;width:100%;min-height:190px;color:var(--dsw-alias-brand-primary);
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-md)}
.dpr-cmpLineLegend{display:flex;flex-wrap:wrap;gap:5px 12px;font-size:11px;
  color:var(--dsw-alias-label-secondary)}
.dpr-cmpAnchors{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.dpr-cmpConcept{display:flex;flex-direction:column;gap:10px}
.dpr-cmpConceptLegend{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:11px;
  color:var(--dsw-alias-label-secondary)}
.dpr-cmpConceptLegend span{padding:2px 6px;background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dpr-cmpConceptSvg{display:block;width:100%;min-width:720px;height:auto;overflow:visible}
.dpr-cmpConceptEdge{fill:none;stroke:color-mix(in srgb,var(--dsw-alias-label-tertiary) 68%,transparent);stroke-width:1.6}
.dpr-cmpConceptNode{box-sizing:border-box;height:100%;padding:9px 10px;overflow:hidden;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.dpr-cmpConceptNode.is-synthesis{background:var(--dsw-alias-bg-layer-1);border-style:dashed}
.dpr-cmpConceptNode.is-grounded{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 58%,var(--dsw-alias-border-l2))}
.dpr-cmpConceptKind{display:block;margin-bottom:3px;font-size:9px;line-height:1.3;
  color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:.04em}
.dpr-cmpConceptNode strong{display:block;font-size:12px;line-height:1.35;margin-bottom:3px}
.dpr-cmpConceptNode p{margin:0;font-size:10px;line-height:1.42;color:var(--dsw-alias-label-secondary)}
.dpr-cmpConceptAnchors{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
.dpr-cmpVersionGrid{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:start}
.dpr-cmpVersionCol{min-width:0;padding:10px;background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);
  max-height:calc(100vh - 220px);overflow:auto}
.dpr-cmpVersionCol h3{margin:0 0 7px;font-size:13px;color:var(--dsw-alias-label-primary)}
.dpr-cmpVersionSide{padding:6px 8px;margin-bottom:8px;background:var(--dsw-alias-bg-base);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dpr-cmpVersionSide strong{display:block;font-size:12px;line-height:1.4;color:var(--dsw-alias-label-primary)}
.dpr-cmpVersionSide span{display:block;margin-top:2px;font-size:10px;color:var(--dsw-alias-label-tertiary)}
.dpr-cmpVersionItem{padding:7px;margin-bottom:6px;background:var(--dsw-alias-bg-base);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dpr-cmpVersionItem p{margin:4px 0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);
  white-space:pre-wrap}
.dpr-cmpCitingBanner{flex:none;display:flex;align-items:center;justify-content:space-between;gap:10px;
  padding:7px 12px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l2)}
.dpr-cmpCitingBanner p{margin:2px 0 0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);
  max-height:3em;overflow:auto}
.dpr-cmpCitingBanner .dpr-back{flex:none;padding:4px 8px;font-size:11px}
.dpr-cmpTopError{margin:6px 12px 0}
.dpr-cmpToast{position:absolute;right:42px;bottom:14px;z-index:58;max-width:320px;padding:7px 10px;
  font-size:11px;line-height:1.45;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dpr-cmpCitePopover{position:absolute;left:18px;top:76px;z-index:70;width:min(380px,calc(100% - 36px));
  max-height:60%;overflow:auto;display:flex;flex-direction:column;gap:7px;padding:11px 12px;
  background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l3);
  border-radius:var(--dsw-radius-md);box-shadow:0 14px 38px color-mix(in srgb,var(--dsw-alias-label-primary) 20%,transparent)}
.dpr-cmpCiteHead{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dpr-cmpCiteKicker{font-size:10px;color:var(--dsw-alias-label-tertiary)}
.dpr-cmpCitePopover h3{margin:0;font-size:var(--dsh-content-font-size,14px);line-height:1.4;
  color:var(--dsw-alias-label-primary)}
.dpr-cmpCiteAbstract{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);
  max-height:9em;overflow:auto}

@media (max-width:1100px){
  .dpr-cmpBody{grid-template-columns:1fr;grid-template-rows:minmax(0,1fr) auto}
  .dpr-cmpPapers{grid-template-columns:1fr 1fr;min-height:52vh}
  .dpr-cmpWorkspace{border-left:0;border-top:1px solid var(--dsw-alias-border-l2);max-height:46vh}
  .dpr-cmpRail{top:70px}
  .dpr-cmpArtWindow{inset:56px 8px 8px}
  .dpr-cmpCitePopover{left:8px;top:64px}
}

@media (max-width:820px){
  .dpr-cmpPapers{grid-template-columns:1fr;min-height:0;overflow:auto}
  .dpr-cmpPaperPane{min-height:45vh}
  .dpr-cmpLogicGrid{grid-template-columns:1fr}
}

@media (max-width:1100px){
  .dpr-compareRoot{padding:0}
  .dpr-comparePanel{width:100%;height:100%;border-radius:0;border:0}
  .dpr-compareBody{grid-template-columns:1fr;grid-template-rows:minmax(0,1fr) auto}
  .dpr-compareSide{border-left:0;border-top:1px solid var(--dsw-alias-border-l2);max-height:42vh}
  .dpr-compareTable th{position:static}
  .dpr-compareTable td:first-child,.dpr-compareTable th:first-child{position:static}
}
.dpr-readerTitle{margin:6px 0 8px;font-size:calc(var(--dsh-content-font-size,14px) + 10px);line-height:1.25;
  color:var(--dsw-alias-label-primary)}
.dpr-readerMeta{margin:0 0 8px;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.6;
  color:var(--dsw-alias-label-secondary)}
.dpr-readerBadges{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 18px}
.dpr-versionField{display:inline-flex;align-items:center;gap:3px}
.dpr-versionSelect{border:0;background:transparent;color:var(--dsw-alias-link);font:inherit;padding:0 14px 0 0;
  cursor:pointer;max-width:150px}
.dpr-versionSelect:focus{outline:2px solid var(--dsw-alias-link);outline-offset:1px;border-radius:var(--dsw-radius-sm)}
.dpr-readerBadge{padding:3px 7px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;
  font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1,transparent)}
.dpr-readerH{margin:28px 0 10px;font-size:calc(var(--dsh-content-font-size,14px) + 4px);line-height:1.3;
  color:var(--dsw-alias-label-primary);scroll-margin-top:48px}
.dpr-readerP{margin:0 0 13px;font-size:var(--dsh-content-font-size,14px);line-height:1.75;text-align:left;
  text-indent:0;color:var(--dsw-alias-label-primary)}
.dpr-readerSeparator{height:1px;margin:18px 0;border:0;background:var(--dsw-alias-border-l2)}
.dpr-readerAlgorithmRule{height:1px;margin:10px 0;border:0;background:var(--dsw-alias-border-l2)}
.dpr-biBlock{margin:0 0 16px}
.dpr-biPair{margin:0 0 8px}
.dpr-biSource{display:block;font-size:var(--dsh-content-font-size,14px);line-height:1.72;
  color:var(--dsw-alias-label-primary)}
.dpr-biTarget{display:block;margin-top:3px;padding-left:9px;border-left:2px solid var(--dsw-alias-link);
  font-size:var(--dsh-content-font-size,14px);line-height:1.72;color:var(--dsw-alias-label-secondary)}
.dpr-biTargetTitle{display:block;margin:0 0 8px;font-size:calc(var(--dsh-content-font-size,14px) + 5px);line-height:1.35;
  color:var(--dsw-alias-label-secondary);font-weight:500}
.dpr-biCaptionPair{margin-top:6px}
.dpr-readerAbstract{padding:12px 14px;margin:0 0 18px;background:var(--dsw-alias-settings-card-fill);
  border-left:3px solid var(--dsw-alias-brand-primary);border-radius:0 var(--dsw-radius-sm) var(--dsw-radius-sm) 0}
.dpr-readerAbstract .dpr-readerP{margin:0;font-size:var(--dsh-content-font-size-secondary,13px)}
.dpr-readerFigure{margin:20px 0;padding:9px;background:var(--dsw-alias-settings-card-fill);
  border:1px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-md)}
.dpr-readerFigure img{display:block;max-width:100%;height:auto;margin:0 auto;border-radius:var(--dsw-radius-sm)}
.dpr-readerFigure figcaption{margin-top:8px;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.55;
  color:var(--dsw-alias-label-secondary)}
.dpr-latexBox{display:flex;align-items:flex-start;gap:8px;margin-top:8px;padding:8px 9px;border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-l1);border:1px solid var(--dsw-alias-border-l2)}
.dpr-latexCode{flex:1;min-width:0;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:var(--dsw-font-mono,monospace);
  font-size:var(--dsh-content-font-size-secondary,13px);color:var(--dsw-alias-label-primary)}
.dpr-formulaWarn{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.5}
.dpr-latexInput{flex:1;min-width:0;padding:5px 7px;border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);
  font-family:var(--dsw-font-mono,monospace);font-size:var(--dsh-content-font-size-secondary,13px)}
.dpr-latexInput:focus{outline:2px solid var(--dsw-alias-link);outline-offset:1px}
.dpr-tableTransWrap{margin-top:10px;max-width:100%;overflow:auto;border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-l1)}
.dpr-tableTrans{width:100%;border-collapse:collapse;font-size:var(--dsh-content-font-size-secondary,13px)}
.dpr-tableTrans th,.dpr-tableTrans td{padding:5px 7px;border-bottom:1px solid var(--dsw-alias-border-l2);
  border-right:1px solid var(--dsw-alias-border-l2);text-align:left;vertical-align:top;min-width:64px}
.dpr-tableTrans tr:last-child td{border-bottom:0}
.dpr-tableTrans th:last-child,.dpr-tableTrans td:last-child{border-right:0}
.dpr-tableTrans th{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-settings-card-fill);font-weight:600}
.dpr-readerCode{margin:14px 0;padding:11px 13px;overflow:auto;white-space:pre-wrap;word-break:break-word;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.55;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dpr-readerPage{display:inline-block;margin-left:6px;padding:1px 5px;font-size:10px;border:1px solid var(--dsw-alias-border-l2);
  border-radius:999px;color:var(--dsw-alias-label-tertiary);text-decoration:none;white-space:nowrap;
  vertical-align:middle;user-select:none;opacity:.82;background:var(--dsw-alias-bg-layer-1);font:inherit;
  line-height:1.25;cursor:pointer}
.dpr-readerPage:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}
.dpr-readerPage:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dpr-readerPage.is-flow{opacity:.62}
.dpr-readerPage.is-special{opacity:.92;font-weight:500}
.dpr-readerP>.dpr-readerPage,.dpr-readerMeta>.dpr-readerPage,.dpr-readerRef>.dpr-readerPage{
  float:right;margin:2px 0 2px 8px}
.dpr-readerRefs{list-style:none;padding-left:0;margin:10px 0 0}
.dpr-readerRef{font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.55;color:var(--dsw-alias-label-secondary);
  margin-bottom:8px;overflow-wrap:anywhere}
.dpr-citeLink{display:inline;padding:0 1px;border:0;background:transparent;font:inherit;line-height:inherit;
  color:var(--dsw-alias-link);
  color:color-mix(in srgb,var(--dsw-alias-link) 65%,var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-layer-2)));
  font-weight:600;
  cursor:pointer;text-decoration:underline;text-decoration-style:dotted;
  text-decoration-color:currentColor;text-underline-offset:2px;border-radius:3px}
.dpr-citeLink:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dpr-citeLink:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dpr-citeOverlay{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;
  padding:24px;background:rgba(0,0,0,.22)}
.dpr-sourceOverlay{position:absolute;inset:0;z-index:45;display:flex;align-items:center;justify-content:center;
  padding:18px;background:rgba(0,0,0,.34)}
.dpr-sourceCard{display:flex;flex-direction:column;width:min(1040px,100%);height:min(820px,calc(100vh - 56px));
  overflow:hidden;background:var(--dsw-alias-settings-card-fill);border:1px solid var(--dsw-alias-border-l3);
  border-radius:var(--dsw-radius-lg);box-shadow:0 18px 50px rgba(0,0,0,.28)}
.dpr-sourceBody{flex:1;min-height:0;overflow:auto;padding:12px;text-align:center;
  background:var(--dsw-alias-bg-layer-2)}
.dpr-sourceImage{display:block;max-width:100%;height:auto;margin:0 auto;
  background:var(--dsw-alias-settings-card-fill);box-shadow:0 4px 18px rgba(0,0,0,.14)}
.dpr-sourceError{padding:36px 20px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6}
.dpr-sourceActions{display:flex;align-items:center;justify-content:center;gap:8px;padding:10px 12px;
  border-top:1px solid var(--dsw-alias-border-l2)}
.dpr-sourceActions .dpr-back{margin:0;text-decoration:none}
.dpr-sourceActions .dpr-back:disabled{opacity:.48;cursor:not-allowed}
@media (max-width:560px){
  .dpr-sourceOverlay{padding:8px}
  .dpr-sourceCard{height:calc(100vh - 24px)}
  .dpr-sourceBody{padding:6px}
  .dpr-sourceActions{flex-wrap:wrap}
}
.dpr-citeCard{display:flex;flex-direction:column;width:min(760px,100%);height:min(580px,calc(100vh - 96px));
  overflow:hidden;background:var(--dsw-alias-settings-card-fill);border:1px solid var(--dsw-alias-border-l3);
  border-radius:var(--dsw-radius-lg);box-shadow:0 18px 50px rgba(0,0,0,.24)}
.dpr-citeHead{display:flex;align-items:flex-start;gap:10px;padding:12px 14px;
  border-bottom:1px solid var(--dsw-alias-border-l2)}
.dpr-citeHeadMain{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.dpr-citeKicker{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.dpr-citeTitle{font-size:var(--dsh-content-font-size,14px);font-weight:650;line-height:1.35;
  color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dpr-citeMetaLine{font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dpr-citeBadges{display:flex;flex-wrap:wrap;gap:5px;margin-top:2px}
.dpr-citeBadge{padding:1px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;
  font-size:10px;color:var(--dsw-alias-label-secondary)}
.dpr-citeBadge.is-warn{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dpr-citeClose{flex:none;width:26px;height:26px;padding:0;border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);
  font:inherit;line-height:1;cursor:pointer}
.dpr-citeClose:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3)}
.dpr-citeBody{display:grid;grid-template-columns:136px minmax(0,1fr);flex:1;min-height:0}
.dpr-citeNav{display:flex;flex-direction:column;gap:3px;padding:8px;overflow:auto;
  border-right:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.dpr-citeNav button{width:100%;padding:6px 8px;border:1px solid transparent;border-radius:var(--dsw-radius-sm);
  background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:1.35;
  text-align:left;cursor:pointer}
.dpr-citeNav button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dpr-citeNav button.is-active{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-settings-card-fill);
  color:var(--dsw-alias-label-primary);font-weight:650}
.dpr-citeContent{min-width:0;overflow:auto;padding:13px 15px 18px;scroll-behavior:smooth}
.dpr-citeSection{margin:0 0 18px;scroll-margin-top:8px}
.dpr-citeSection h4{margin:0 0 7px;font-size:12px;letter-spacing:.04em;color:var(--dsw-alias-label-primary)}
.dpr-citeField{display:grid;grid-template-columns:64px minmax(0,1fr);gap:7px;margin:0 0 8px;
  font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary)}
.dpr-citeField b{font-weight:650;color:var(--dsw-alias-label-primary)}
.dpr-citeSummary{margin:0 0 9px;font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary)}
.dpr-citeStance{display:inline-flex;align-items:center;gap:5px;padding:2px 7px;margin-bottom:7px;
  border:1px solid var(--dsw-alias-border-l2);border-radius:999px;font-size:11px;color:var(--dsw-alias-label-primary)}
.dpr-citePoint{margin:0 0 9px;padding:8px 9px;border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2)}
.dpr-citePoint p{margin:0 0 5px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary)}
.dpr-citeEvidence{font-size:11px;line-height:1.55;color:var(--dsw-alias-label-tertiary)}
.dpr-citeEvidence span{display:block;overflow-wrap:anywhere}
.dpr-citeWarn{margin:0 0 10px;padding:7px 9px;border-left:2px solid var(--dsw-alias-brand-primary);
  background:var(--dsw-alias-bg-layer-2);font-size:11px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.dpr-citeFrom{display:flex;align-items:center;gap:8px;justify-content:space-between;width:100%;max-width:720px;
  margin:0 auto 10px;box-sizing:border-box;padding:7px 9px;border:1px solid var(--dsw-alias-border-l2);
  border-left:2px solid var(--dsw-alias-brand-primary);border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-2);font-size:11px;line-height:1.45;color:var(--dsw-alias-label-secondary)}
.dpr-citeFrom .dpr-back{flex:none;white-space:nowrap;padding:4px 8px;font-size:11px}
.dpr-citeStages{display:flex;flex-direction:column;gap:6px;margin:0;padding:0;list-style:none}
.dpr-citeStage{display:flex;gap:7px;align-items:flex-start;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dpr-citeStageDot{flex:none;width:7px;height:7px;margin-top:5px;border:1px solid var(--dsw-alias-border-l3);border-radius:50%}
.dpr-citeStage.is-active{color:var(--dsw-alias-label-primary);font-weight:600}
.dpr-citeStage.is-active .dpr-citeStageDot{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dpr-citeStage.is-done .dpr-citeStageDot{background:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-label-secondary)}
.dpr-citeActions{display:flex;flex-wrap:wrap;gap:7px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-settings-card-fill)}
.dpr-citeActions .dpr-primary{width:auto;padding:7px 12px;font-size:12px}
.dpr-citeActions .dpr-back{font-size:12px}
.dpr-citeChoices{display:flex;flex-wrap:wrap;gap:5px;margin:0 0 10px}
.dpr-citeChoices button{padding:2px 7px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}
.dpr-citeChoices button:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.dpr-glossaryBody{display:flex;flex-direction:column;gap:7px;min-height:0;overflow:auto;padding:12px 14px}
.dpr-glossaryHint{padding:7px 9px;border-left:2px solid var(--dsw-alias-link);background:var(--dsw-alias-bg-layer-2);
  font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dpr-glossaryRow{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto auto;gap:6px;align-items:center}
.dpr-glossaryRow input[type=text]{width:100%;min-width:0;box-sizing:border-box;padding:5px 7px;font:inherit;
  font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dpr-glossaryRow input[type=text]:focus{outline:2px solid var(--dsw-alias-link);outline-offset:1px}
.dpr-glossaryLock{display:flex;align-items:center;gap:3px;font-size:10px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dpr-glossaryDelete{padding:2px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;
  background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;cursor:pointer}
.dpr-glossaryDelete:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3)}
.dpr-glossaryActions{display:flex;flex-wrap:wrap;gap:7px;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l2)}
.dpr-glossaryEmpty{padding:12px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dpr-reviewBody{display:flex;flex-direction:column;gap:9px;min-height:0;overflow:auto;padding:12px 14px}
.dpr-reviewIssue{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-l1);padding:10px 11px;display:flex;flex-direction:column;gap:7px}
.dpr-reviewIssue.is-error{border-left:3px solid var(--dsw-alias-label-primary)}
.dpr-reviewIssue.is-warning{border-left:3px solid var(--dsw-alias-link)}
.dpr-reviewHead{display:flex;align-items:center;gap:7px;flex-wrap:wrap;cursor:pointer}
.dpr-reviewSeverity{font-size:10px;padding:2px 6px;border-radius:999px;background:var(--dsw-alias-settings-card-fill);
  color:var(--dsw-alias-label-secondary)}
.dpr-reviewTask{font-size:10px;color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-mono,monospace)}
.dpr-reviewText{font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.dpr-reviewLabel{font-size:10px;color:var(--dsw-alias-label-tertiary);margin-right:4px}
.dpr-reviewActions{display:flex;gap:6px;flex-wrap:wrap}
.dpr-reviewDecision{font-size:11px;color:var(--dsw-alias-label-secondary);align-self:center}
@media (max-width:1100px){
  .dpr-citeBody{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}
  .dpr-citeNav{flex-direction:row;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l2);
    overflow-x:auto;padding:6px}
  .dpr-citeNav button{width:auto;flex:none;white-space:nowrap}
}
.dpr-selectionBar{position:fixed;z-index:20;transform:translateX(-50%);display:flex;flex-direction:column;
  align-items:stretch;gap:6px;min-width:250px;max-width:340px;padding:7px;
  background:var(--dsw-alias-settings-card-fill);border:1px solid var(--dsw-alias-border-l3);
  border-radius:var(--dsw-radius-md);will-change:top,left}
.dpr-selectionBar textarea{width:100%;min-height:54px;max-height:120px;padding:7px 8px;resize:vertical;
  font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);box-sizing:border-box}
.dpr-selectionBar textarea:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dpr-selectionActions{display:flex;align-items:center;gap:7px}
.dpr-selectionBtn{display:inline-flex;align-items:center;padding:6px 10px;font:inherit;
  font-size:var(--dsh-content-font-size-secondary,13px);font-weight:650;color:var(--dsw-alias-label-primary);
  cursor:pointer;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-brand-primary);
  border-radius:var(--dsw-radius-sm);white-space:nowrap}
.dpr-selectionBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dpr-selectionBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dpr-selectionBtn.is-secondary{color:var(--dsw-alias-label-secondary);
  border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base)}
.dpr-selectionBtn:disabled{opacity:.55;cursor:not-allowed}
.dpr-selectionHint{font-size:10px;line-height:1.35;color:var(--dsw-alias-label-tertiary);max-width:120px}
.dpr-termCard{position:fixed;z-index:90;width:min(430px,calc(100vw - 24px));max-height:min(560px,calc(100vh - 28px));
  overflow:auto;display:flex;flex-direction:column;gap:10px;padding:13px 14px;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);
  border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);
  box-shadow:0 16px 44px color-mix(in srgb,var(--dsw-alias-label-primary) 22%,transparent)}
.dpr-termHead{display:flex;align-items:flex-start;gap:9px}
.dpr-termHeadMain{flex:1;min-width:0}
.dpr-termKicker{font-size:10px;line-height:1.4;color:var(--dsw-alias-label-tertiary)}
.dpr-termWord{margin:2px 0 0;font-size:19px;line-height:1.28;overflow-wrap:anywhere}
.dpr-termBadges{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}
.dpr-termBadge{padding:2px 6px;font-size:10px;line-height:1.45;color:var(--dsw-alias-label-secondary);
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-sm)}
.dpr-termBadge.is-high{color:var(--dsw-alias-state-success-primary)}
.dpr-termBadge.is-low{color:var(--dsw-alias-state-warn-label)}
.dpr-termClose{flex:none;padding:1px 7px;font:inherit;font-size:18px;line-height:1.3;cursor:pointer;
  color:var(--dsw-alias-label-tertiary);background:transparent;border:1px solid transparent;
  border-radius:var(--dsw-radius-sm)}
.dpr-termClose:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dpr-termMeaning{margin:0;padding:10px 11px;font-size:14px;line-height:1.65;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);
  border-left:3px solid var(--dsw-alias-brand-primary);border-radius:var(--dsw-radius-sm);white-space:pre-wrap}
.dpr-termField{display:flex;flex-direction:column;gap:3px;margin:0}
.dpr-termField b{font-size:10px;line-height:1.4;color:var(--dsw-alias-label-tertiary);font-weight:600}
.dpr-termField span{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}
.dpr-termQuote{margin:0;padding:7px 9px;font-size:11px;line-height:1.55;
  color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dpr-termWarnings{margin:0;padding-left:17px;font-size:11px;line-height:1.55;
  color:var(--dsw-alias-state-warn-label)}
.dpr-termFoot{display:flex;align-items:center;gap:7px;flex-wrap:wrap;
  padding-top:9px;border-top:1px solid var(--dsw-alias-border-l2)}
.dpr-termLocator{flex:1;min-width:120px;font-size:10px;line-height:1.45;color:var(--dsw-alias-label-tertiary)}
.dpr-termFoot button{padding:4px 8px;font:inherit;font-size:11px;cursor:pointer;
  color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dpr-termLoading,.dpr-termError{padding:16px 8px;text-align:center;font-size:12px;line-height:1.6;
  color:var(--dsw-alias-label-secondary)}
.dpr-termError{color:var(--dsw-alias-state-error-primary)}
.dpr-termCard.is-narrow{gap:8px;padding:11px 12px;border-radius:var(--dsw-radius-md)}
.dpr-termCard.is-narrow .dpr-termWord{font-size:17px}
.dpr-termCard.is-narrow .dpr-termMeaning{font-size:13px;line-height:1.58}
.dpr-termCard.is-narrow .dpr-termField span{font-size:11px}
.dpr-askNote{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 14px;padding:8px 10px;
  font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5;color:var(--dsw-alias-label-secondary);
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dpr-annotationDock{display:flex;flex-direction:column;gap:8px;margin:7px 0 0;padding:9px 10px;
  background:var(--dsw-alias-settings-card-fill);border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-md);font-size:var(--dsh-content-font-size-secondary,13px);
  color:var(--dsw-alias-label-secondary)}
.dpr-annotationHead{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dpr-annotationSummary{display:inline-flex;align-items:center;gap:5px;padding:4px 8px;font:inherit;
  font-size:var(--dsh-content-font-size-secondary,13px);font-weight:650;color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l3);
  border-radius:999px;cursor:pointer}
.dpr-annotationSummary:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dpr-annotationList{display:flex;flex-direction:column;gap:7px}
.dpr-annotationItem{display:flex;flex-direction:column;gap:5px;padding:7px;background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.dpr-annotationItem textarea{width:100%;min-height:44px;max-height:100px;padding:6px;resize:vertical;font:inherit;
  font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.45;color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-settings-card-fill);border:1px solid var(--dsw-alias-border-l3);
  border-radius:var(--dsw-radius-sm);box-sizing:border-box}
.dpr-annotationHint{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dpr-annotationMeta{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dpr-annotationMeta button{margin-left:auto;padding:2px 6px;font:inherit;font-size:11px;color:var(--dsw-alias-label-secondary);
  background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;cursor:pointer}
.dpr-annotationMeta button:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}
.dpr-bubbleWrap{display:inline-flex;align-items:center;margin-left:6px;vertical-align:middle}
.dpr-bubble{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;
  font:inherit;font-size:10px;line-height:1;color:var(--dpr-on-brand);cursor:pointer;
  background:var(--dpr-brand-strong);border:1px solid var(--dpr-line-strong);
  border-radius:999px}
.dpr-bubble:hover{filter:brightness(1.08)}
.dpr-bubbleX{margin-left:2px;padding:0;width:13px;height:13px;font-size:10px;line-height:1;color:var(--dsw-alias-label-tertiary);
  background:transparent;border:0;cursor:pointer}
.dpr-bubbleX:hover{color:var(--dsw-alias-label-primary)}
.dpr-flash{animation:dpr-highlight 2.2s ease-in-out 1;border-radius:var(--dsw-radius-sm)}
@keyframes dpr-highlight{
  0%,100%{background-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}
  25%,75%{background-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 42%,transparent)}
  50%{background-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}
}
.dpr-readerFigure.dpr-flash{animation:dpr-highlight-box 2.2s ease-in-out 1}
@keyframes dpr-highlight-box{
  0%,100%{box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}
  25%,75%{box-shadow:0 0 0 5px color-mix(in srgb,var(--dsw-alias-brand-primary) 42%,transparent)}
  50%{box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}
}
@media (prefers-reduced-motion: reduce){.dpr-flash,.dpr-readerFigure.dpr-flash{animation:none;background-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}}

/* ==========================================================================
   UI foundation v1
   --------------------------------------------------------------------------
   这一层只映射宿主 token、统一表面层级与交互状态，不改变 DOM、事件、API 或
   数据流。页面专用规则放后面，按需覆盖这里的通用值。
   ========================================================================== */
:where(.dpr-pane,.dpr-compareRoot,.dpr-maintenanceOverlay){
  --dpr-space-1:4px;
  --dpr-space-2:8px;
  --dpr-space-3:12px;
  --dpr-space-4:16px;
  --dpr-space-5:24px;
  --dpr-space-6:32px;
  --dpr-radius-xs:var(--dsw-radius-xs);
  --dpr-radius-sm:var(--dsw-radius-sm);
  --dpr-radius-md:var(--dsw-radius-md);
  --dpr-radius-lg:var(--dsw-radius-lg);
  --dpr-font-xs:max(11px,calc(var(--dsh-content-font-size-secondary,13px) - 1px));
  --dpr-font-sm:var(--dsh-content-font-size-secondary,13px);
  --dpr-font-body:var(--dsh-content-font-size,14px);
  --dpr-font-title:calc(var(--dsh-content-font-size,14px) + 6px);
  --dpr-host-base:var(--dsw-alias-bg-base);
  --dpr-host-raised:var(--dsw-alias-settings-card-fill);
  --dpr-host-soft:var(--dsw-alias-bg-layer-2);
  --dpr-paper-warm:color-mix(in srgb,var(--dpr-host-base) 92%,var(--dpr-warn) 8%);
  --dpr-surface-base:color-mix(in srgb,var(--dpr-paper-warm) 97%,var(--dsw-alias-link) 3%);
  --dpr-surface-raised:color-mix(in srgb,var(--dpr-host-base) 94%,var(--dpr-warn) 6%);
  --dpr-surface-muted:color-mix(in srgb,var(--dpr-host-base) 90%,var(--dpr-warn) 10%);
  --dpr-surface-soft:color-mix(in srgb,var(--dpr-host-base) 86%,var(--dpr-warn) 14%);
  --dpr-paper:var(--dpr-surface-raised);
  --dpr-line:color-mix(in srgb,var(--dpr-ink) 22%,var(--dpr-surface-raised));
  --dpr-line-strong:color-mix(in srgb,var(--dsw-static-neutral-bluish-1000) 78%,var(--dsw-alias-link) 22%);
  --dpr-ink:color-mix(in srgb,var(--dsw-alias-label-primary) 86%,var(--dsw-alias-link) 14%);
  --dpr-ink-secondary:color-mix(in srgb,var(--dsw-alias-label-secondary) 92%,var(--dsw-alias-link) 8%);
  --dpr-ink-tertiary:color-mix(in srgb,var(--dsw-alias-label-tertiary) 94%,var(--dsw-alias-link) 6%);
  --dpr-link:color-mix(in srgb,var(--dsw-alias-link) 72%,var(--dsw-static-neutral-bluish-1000) 28%);
  --dpr-brand:var(--dpr-link);
  --dpr-brand-strong:color-mix(in srgb,var(--dsw-alias-link) 66%,var(--dsw-static-neutral-bluish-1000) 34%);
  --dpr-on-brand:var(--dsw-static-neutral-bluish-00);
  --dpr-warn:var(--dsw-alias-state-warn-label);
  --dpr-error:var(--dsw-alias-state-error-primary);
  --dpr-shadow-ink:color-mix(in srgb,var(--dsw-static-neutral-bluish-1000) 42%,transparent);
  --dpr-shadow-card:2px 2px 0 var(--dpr-shadow-ink);
  --dpr-shadow-raised:4px 4px 0 color-mix(in srgb,var(--dsw-static-neutral-bluish-1000) 54%,transparent);
  --dpr-pattern:radial-gradient(circle at 1px 1px,
    color-mix(in srgb,var(--dpr-ink) 7%,transparent) 1px,transparent 0);
  --dpr-fast:120ms;
  --dpr-base:180ms;
  --dpr-ease:cubic-bezier(.2,.8,.2,1);
}

:where(body[data-ds-dark-theme] .dpr-pane,body[data-ds-dark-theme] .dpr-compareRoot,
body[data-ds-dark-theme] .dpr-maintenanceOverlay){
  --dpr-surface-base:color-mix(in srgb,var(--dpr-host-base) 70%,var(--dsw-static-blue-950) 30%);
  --dpr-dark-raised-base:color-mix(in srgb,var(--dsw-static-blue-950) 50%,var(--dsw-static-neutral-bluish-850) 50%);
  --dpr-surface-raised:color-mix(in srgb,var(--dpr-dark-raised-base) 70%,var(--dsw-static-neutral-bluish-900) 30%);
  --dpr-surface-muted:color-mix(in srgb,var(--dsw-static-blue-950) 55%,var(--dsw-static-neutral-bluish-850) 45%);
  --dpr-surface-soft:color-mix(in srgb,var(--dsw-static-blue-950) 55%,var(--dsw-static-neutral-bluish-800) 45%);
  --dpr-dark-brand-base:color-mix(in srgb,var(--dsw-static-deepseek-400) 60%,var(--dsw-static-green-400) 40%);
  --dpr-brand:color-mix(in srgb,var(--dpr-dark-brand-base) 75%,var(--dsw-static-neutral-bluish-400) 25%);
  --dpr-link:var(--dpr-brand);
  --dpr-brand-strong:color-mix(in srgb,var(--dsw-static-deepseek-500) 60%,var(--dsw-static-neutral-bluish-900) 40%);
  --dpr-warn:color-mix(in srgb,var(--dsw-static-amber-500) 65%,var(--dsw-static-amber-600) 35%);
  --dpr-ink:color-mix(in srgb,var(--dsw-alias-label-primary) 90%,var(--dsw-alias-state-warn-label) 10%);
  --dpr-ink-secondary:color-mix(in srgb,var(--dsw-alias-label-secondary) 80%,var(--dsw-alias-label-primary) 20%);
  --dpr-ink-tertiary:color-mix(in srgb,var(--dsw-alias-label-tertiary) 85%,var(--dpr-brand) 15%);
  --dpr-dark-line-base:color-mix(in srgb,var(--dpr-surface-soft) 75%,var(--dpr-brand) 25%);
  --dpr-line:color-mix(in srgb,var(--dpr-dark-line-base) 90%,var(--dsw-alias-label-secondary) 10%);
  --dpr-line-strong:color-mix(in srgb,var(--dsw-static-neutral-bluish-1000) 92%,var(--dsw-static-deepseek-500) 8%);
  --dpr-shadow-ink:color-mix(in srgb,var(--dsw-static-neutral-bluish-1000) 72%,transparent);
}

:where(.dpr-pane,.dpr-compareRoot,.dpr-maintenanceOverlay) button,
:where(.dpr-pane,.dpr-compareRoot,.dpr-maintenanceOverlay) input,
:where(.dpr-pane,.dpr-compareRoot,.dpr-maintenanceOverlay) textarea,
:where(.dpr-pane,.dpr-compareRoot,.dpr-maintenanceOverlay) select{
  font-family:inherit;
}

:where(.dpr-pane,.dpr-compareRoot,.dpr-maintenanceOverlay) button:focus-visible,
:where(.dpr-pane,.dpr-compareRoot,.dpr-maintenanceOverlay) input:focus-visible,
:where(.dpr-pane,.dpr-compareRoot,.dpr-maintenanceOverlay) textarea:focus-visible,
:where(.dpr-pane,.dpr-compareRoot,.dpr-maintenanceOverlay) select:focus-visible,
:where(.dpr-pane,.dpr-compareRoot,.dpr-maintenanceOverlay) [tabindex]:focus-visible{
  outline:2px solid var(--dpr-brand);
  outline-offset:2px;
}

.dpr-pane{
  padding:var(--dpr-space-5) 18px var(--dpr-space-6);
  background-color:var(--dpr-surface-base);
  background-image:var(--dpr-pattern);
  background-size:8px 8px;
}
.dpr-readerPane{background-image:none}
.dpr-col{max-width:440px;gap:var(--dpr-space-4)}

.dpr-hero{
  position:relative;
  gap:var(--dpr-space-2);
  padding:var(--dpr-space-5) var(--dpr-space-4) var(--dpr-space-4);
  overflow:hidden;
  background:color-mix(in srgb,var(--dpr-brand) 3%,var(--dpr-surface-raised));
  border:1px solid var(--dpr-line-strong);
  border-radius:var(--dpr-radius-lg);
}
.dpr-hero::before{
  content:"";
  position:absolute;
  inset:7px;
  pointer-events:none;
  border:1px dashed color-mix(in srgb,var(--dpr-brand) 35%,transparent);
  border-radius:calc(var(--dpr-radius-lg) - 4px);
}
.dpr-hero::after{
  content:"";
  position:absolute;
  top:14px;
  left:14px;
  width:9px;
  height:9px;
  background:var(--dpr-brand);
  border:1px solid var(--dpr-ink);
  border-radius:2px;
  box-shadow:2px 2px 0 color-mix(in srgb,var(--dpr-ink) 24%,transparent);
}
.dpr-hero > *{position:relative;z-index:1}
.dpr-mascot{
  max-width:132px;
  height:auto;
  padding:4px;
  background:color-mix(in srgb,var(--dpr-warn) 10%,var(--dpr-surface-raised));
  border:2px solid var(--dpr-line-strong);
  border-radius:20px 8px 20px 8px;
  box-shadow:var(--dpr-shadow-raised);
  transform:rotate(1.5deg);
}
.dpr-question{
  font-size:var(--dpr-font-title);
  letter-spacing:-.015em;
  text-wrap:balance;
}
.dpr-sub{max-width:34em;text-wrap:pretty}

.dpr-paths{counter-reset:dpr-route;gap:var(--dpr-space-3)}
.dpr-card{
  position:relative;
  align-items:flex-start;
  min-height:168px;
  padding:var(--dpr-space-4) var(--dpr-space-3) var(--dpr-space-3);
  text-align:left;
  background:var(--dpr-surface-raised);
  border:1px solid var(--dpr-line-strong);
  border-radius:var(--dpr-radius-md);
  box-shadow:var(--dpr-shadow-card);
  transition:transform var(--dpr-fast) var(--dpr-ease),box-shadow var(--dpr-fast) var(--dpr-ease),
    border-color var(--dpr-fast) var(--dpr-ease);
}
.dpr-card:nth-child(odd){
  background:color-mix(in srgb,var(--dpr-brand) 10%,var(--dpr-surface-raised));
}
.dpr-card::before{
  counter-increment:dpr-route;
  content:"0" counter(dpr-route);
  position:absolute;
  top:11px;
  right:11px;
  color:var(--dpr-ink-tertiary);
  font-family:var(--dsw-font-mono,ui-monospace,monospace);
  font-size:9px;
  letter-spacing:.04em;
}
.dpr-card:hover{
  transform:translate(-1px,-1px);
  border-color:var(--dpr-brand);
  box-shadow:3px 3px 0 var(--dpr-shadow-ink);
}
.dpr-card:active{
  transform:translate(1px,1px);
  box-shadow:1px 1px 0 var(--dpr-shadow-ink);
}
.dpr-cardArt{
  width:32px;
  height:32px;
  padding:7px;
  box-sizing:content-box;
  background:color-mix(in srgb,var(--dpr-brand) 13%,var(--dpr-surface-raised));
  border:1px solid var(--dpr-line-strong);
  border-radius:9px;
  box-shadow:2px 2px 0 var(--dpr-shadow-ink);
}
.dpr-cardTitle{font-size:var(--dpr-font-body);font-weight:720}
.dpr-cardDesc{line-height:1.6}
.dpr-cardGo{
  color:var(--dpr-link);
  font-size:var(--dpr-font-xs);
  font-weight:700;
}

.dpr-surveyCard{
  position:relative;
  gap:7px;
  padding:var(--dpr-space-3) var(--dpr-space-4);
  background:color-mix(in srgb,var(--dpr-warn) 7%,var(--dpr-surface-soft));
  border:1px solid var(--dpr-line-strong);
  border-radius:var(--dpr-radius-md);
  box-shadow:var(--dpr-shadow-card);
  transition:transform var(--dpr-fast) var(--dpr-ease),box-shadow var(--dpr-fast) var(--dpr-ease);
}
.dpr-surveyCard:hover{
  transform:translate(-1px,-1px);
  border-color:var(--dpr-brand);
  box-shadow:3px 3px 0 var(--dpr-shadow-ink);
}
.dpr-surveyGlyph{
  width:31px;
  height:31px;
  font-size:0;
  color:var(--dpr-brand);
  background:var(--dpr-surface-raised);
  border:1px solid var(--dpr-line-strong);
  border-radius:7px;
  box-shadow:2px 2px 0 var(--dpr-shadow-ink);
}
.dpr-surveyGlyph::before{
  content:"";
  width:13px;
  height:17px;
  border:1px solid currentColor;
  border-radius:2px;
  box-shadow:3px -3px 0 color-mix(in srgb,var(--dpr-brand) 28%,var(--dpr-surface-raised));
}
.dpr-note{line-height:1.6}
.dpr-library{
  gap:var(--dpr-space-2);
  padding-top:var(--dpr-space-4);
  border-top:1px dashed var(--dpr-line);
}
.dpr-libraryTitle{font-size:var(--dpr-font-body);font-weight:720}
.dpr-libraryRefresh,.dpr-maintenanceBtn{
  min-height:28px;
  border-radius:999px;
  transition:border-color var(--dpr-fast) var(--dpr-ease),background var(--dpr-fast) var(--dpr-ease);
}
.dpr-libraryRefresh:hover,.dpr-maintenanceBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dpr-libraryList{gap:6px}
.dpr-libraryItem{
  position:relative;
  gap:3px;
  padding:9px 10px 9px 24px;
  background:var(--dpr-surface-raised);
  border-color:var(--dpr-line);
  border-radius:var(--dpr-radius-sm);
  box-shadow:1px 1px 0 var(--dpr-shadow-ink);
}
.dpr-libraryItem::before{
  content:"";
  position:absolute;
  left:10px;
  top:13px;
  width:7px;
  height:7px;
  background:var(--dpr-brand);
  border:1px solid color-mix(in srgb,var(--dpr-ink) 65%,var(--dpr-line));
  border-radius:2px;
}
.dpr-libraryItem:nth-child(even)::before{background:var(--dpr-warn)}
.dpr-libraryName{font-size:var(--dpr-font-sm)}

.dpr-back,.dpr-choose,.dpr-primary,.dpr-langSwitch,.dpr-compareClose,
.dpr-compareAnchor,.dpr-selectionBtn,.dpr-termFoot button,.dpr-maintenanceActions button{
  transition:transform var(--dpr-fast) var(--dpr-ease),box-shadow var(--dpr-fast) var(--dpr-ease),
    border-color var(--dpr-fast) var(--dpr-ease),background var(--dpr-fast) var(--dpr-ease);
}
.dpr-back,.dpr-choose,.dpr-primary{min-height:36px}
.dpr-choose,.dpr-primary{
  border-radius:var(--dpr-radius-sm);
  font-weight:720;
}
.dpr-choose{box-shadow:var(--dpr-shadow-card)}
.dpr-primary{
  color:var(--dpr-on-brand);
  background:var(--dpr-brand-strong);
  border-color:var(--dpr-line-strong);
  box-shadow:var(--dpr-shadow-card);
}
.dpr-choose:hover:not(:disabled),.dpr-primary:hover:not(:disabled){
  transform:translate(-1px,-1px);
  box-shadow:3px 3px 0 var(--dpr-shadow-ink);
}
.dpr-choose:active:not(:disabled),.dpr-primary:active:not(:disabled){
  transform:translate(1px,1px);
  box-shadow:1px 1px 0 var(--dpr-shadow-ink);
}
.dpr-primary:disabled,.dpr-choose:disabled{box-shadow:none;transform:none;opacity:.55}

.dpr-drop{
  position:relative;
  min-height:180px;
  padding:32px 18px 24px;
  background:color-mix(in srgb,var(--dpr-brand) 5%,var(--dpr-surface-raised));
  border:2px dashed color-mix(in srgb,var(--dpr-brand) 55%,var(--dpr-line-strong));
  border-radius:var(--dpr-radius-md);
  transition:background var(--dpr-fast) var(--dpr-ease),border-color var(--dpr-fast) var(--dpr-ease);
}
.dpr-drop::before{
  content:"";
  width:33px;
  height:42px;
  margin-bottom:5px;
  background:var(--dpr-surface-raised);
  border:2px solid var(--dpr-line-strong);
  border-radius:4px;
  box-shadow:3px 3px 0 var(--dpr-shadow-ink);
}
.dpr-drop::after{
  content:"↓";
  position:absolute;
  top:59px;
  left:calc(50% + 17px);
  display:grid;
  place-items:center;
  width:21px;
  height:21px;
  color:var(--dpr-on-brand);
  background:var(--dpr-brand-strong);
  border:1px solid var(--dpr-line-strong);
  border-radius:5px;
  box-shadow:2px 2px 0 var(--dpr-shadow-ink);
  font-size:13px;
  font-weight:800;
}
.dpr-drop:hover,.dpr-drop.is-over{
  background:color-mix(in srgb,var(--dpr-brand) 12%,var(--dpr-surface-soft));
  border-color:var(--dpr-brand);
}
.dpr-dropTitle{font-size:var(--dpr-font-body);font-weight:720}
.dpr-fileMeta{font-size:var(--dpr-font-xs)}
.dpr-error{
  border-left:3px solid var(--dpr-error);
  border-radius:var(--dpr-radius-sm);
  background:color-mix(in srgb,var(--dpr-error) 6%,var(--dpr-surface-raised));
}
.dpr-todo{gap:var(--dpr-space-2)}
.dpr-todoItem{align-items:flex-start}
.dpr-bullet{
  margin-top:6px;
  border-radius:2px;
  box-shadow:1px 1px 0 color-mix(in srgb,var(--dpr-ink) 22%,transparent);
}

.dpr-load{gap:var(--dpr-space-4)}
.dpr-mascotSlot{
  min-height:176px;
  padding:var(--dpr-space-4);
  background-color:var(--dpr-surface-soft);
  background-image:var(--dpr-pattern);
  background-size:8px 8px;
  border:1px solid var(--dpr-line);
  border-radius:var(--dpr-radius-lg);
}
.dpr-mascotSlot::before{
  content:"";
  position:absolute;
  inset:7px;
  pointer-events:none;
  border:1px dashed color-mix(in srgb,var(--dpr-brand) 32%,transparent);
  border-radius:calc(var(--dpr-radius-lg) - 4px);
}
.dpr-mascotSlot img{
  max-width:132px;
  height:auto;
  padding:3px;
  background:var(--dpr-surface-raised);
  border:1px solid var(--dpr-line-strong);
  border-radius:16px 6px 16px 6px;
  box-shadow:var(--dpr-shadow-card);
}
.dpr-slotNote{z-index:1}
.dpr-stages{gap:var(--dpr-space-2)}
.dpr-stageDot{
  width:8px;
  height:8px;
  border-radius:2px;
}
.dpr-stage.is-active .dpr-stageDot{animation:dpr-stagePulse 1.5s steps(2,end) infinite}
@keyframes dpr-stagePulse{50%{opacity:.42}}
.dpr-bgNote{
  padding:7px 9px;
  background:var(--dpr-surface-soft);
  border:1px solid var(--dpr-line);
  border-radius:var(--dpr-radius-sm);
}

.dpr-reader{
  background-color:var(--dpr-surface-base);
  background-image:var(--dpr-pattern);
  background-size:8px 8px;
}
.dpr-readerBar{
  gap:7px;
  padding:10px 14px;
  background:color-mix(in srgb,var(--dpr-surface-raised) 94%,var(--dpr-brand));
  border-bottom:1px solid var(--dpr-line);
  box-shadow:0 1px 0 color-mix(in srgb,var(--dpr-ink) 7%,transparent);
}
.dpr-readerBody{max-width:840px;padding:24px 28px 64px}
.dpr-readerTitle{margin-top:4px;line-height:1.22;text-wrap:balance}
.dpr-readerMeta{line-height:1.6}
.dpr-readerBadges{gap:6px}
.dpr-readerBadge{
  border-radius:5px;
  background:var(--dpr-surface-soft);
}
.dpr-readerH{scroll-margin-top:104px;text-wrap:balance}
.dpr-readerP{line-height:1.78}
.dpr-readerFigure{
  padding:10px;
  background:var(--dpr-surface-raised);
  border:1px solid var(--dpr-line);
  border-radius:var(--dpr-radius-sm);
  box-shadow:var(--dpr-shadow-card);
}
.dpr-readerFigure figcaption{line-height:1.6}
.dpr-translateNote{
  border-left:3px solid var(--dpr-link);
  border-radius:var(--dpr-radius-sm);
}
.dpr-langSwitch{
  min-height:30px;
  border-radius:999px;
  font-size:var(--dpr-font-xs);
  font-weight:700;
}
.dpr-langSwitch:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dpr-langSwitch.is-active{
  background:color-mix(in srgb,var(--dpr-link) 11%,var(--dpr-surface-raised));
}

.dpr-comparePanel{
  border-radius:var(--dpr-radius-lg);
  box-shadow:0 16px 52px color-mix(in srgb,var(--dpr-ink) 20%,transparent);
}
.dpr-compareHeader{
  background:color-mix(in srgb,var(--dpr-surface-raised) 94%,var(--dpr-brand));
}
.dpr-cmpPaperPane,.dpr-comparePaper{
  box-shadow:var(--dpr-shadow-card);
}
.dpr-compareClose,.dpr-compareAnchor,.dpr-selectionBtn{
  border-radius:var(--dpr-radius-sm);
}

.dpr-maintenanceOverlay{
  background:color-mix(in srgb,var(--dpr-ink) 28%,transparent);
}
.dpr-maintenanceCard{
  border-color:var(--dpr-line-strong);
  box-shadow:0 16px 48px color-mix(in srgb,var(--dpr-ink) 22%,transparent);
}
.dpr-maintenanceStat{
  border-radius:var(--dpr-radius-sm);
  background:var(--dpr-surface-soft);
}
.dpr-maintenanceActions{gap:var(--dpr-space-2)}

@media (max-width:380px){
  .dpr-pane{padding-inline:12px}
  .dpr-hero{padding:20px 12px 14px}
  .dpr-mascot{max-width:108px}
  .dpr-paths{gap:8px}
  .dpr-card{min-height:158px;padding-inline:10px}
  .dpr-cardDesc{font-size:var(--dpr-font-xs)}
  .dpr-readerBody{padding:18px 15px 52px}
}
@media (prefers-reduced-motion:reduce){
  .dpr-stage.is-active .dpr-stageDot{animation:none}
  .dpr-card,.dpr-surveyCard,.dpr-choose,.dpr-primary,.dpr-back,.dpr-langSwitch{
    transition:none;
  }
}

/* --------------------------------------------------------------------------
   Page compositions: approved sample
   -------------------------------------------------------------------------- */
.dpr-homePane,.dpr-importPane{
  align-items:stretch;
  padding:0;
  background-image:var(--dpr-pattern);
  background-size:8px 8px;
}
.dpr-homeCol{
  width:100%;
  height:100%;
  max-width:452px;
  margin:0 auto;
  padding:18px 18px 24px;
  overflow:auto;
}

.dpr-homeHero{
  display:grid;
  grid-template-columns:minmax(0,1fr) 122px;
  align-items:center;
  min-height:198px;
  padding:18px 14px 18px 16px;
  text-align:left;
}
.dpr-homeHero::after{display:none}
.dpr-heroCopy{min-width:0}
.dpr-eyebrow{
  display:flex;
  align-items:center;
  gap:7px;
  margin-bottom:12px;
  color:var(--dpr-link);
  font-family:var(--dsw-font-mono,ui-monospace,monospace);
  font-size:9px;
  line-height:1.2;
  font-weight:800;
  letter-spacing:.08em;
  text-transform:uppercase;
}
.dpr-eyebrow::before{
  content:"";
  flex:none;
  width:8px;
  height:8px;
  background:var(--dpr-brand);
  border:1px solid var(--dpr-ink);
  border-radius:2px;
  box-shadow:2px 2px 0 color-mix(in srgb,var(--dpr-ink) 22%,transparent);
}
.dpr-eyebrowCount{
  margin-left:auto;
  padding:2px 5px;
  color:var(--dpr-ink-tertiary);
  background:var(--dpr-surface-raised);
  border:1px solid var(--dpr-line);
  border-radius:4px;
  font-size:9px;
  letter-spacing:0;
}
.dpr-homeHero .dpr-question{
  margin:0 0 8px;
  font-size:clamp(21px,calc(var(--dpr-font-title) + 2px),26px);
  line-height:1.25;
  letter-spacing:-.025em;
  text-align:left;
}
.dpr-homeHero .dpr-sub{
  margin:0 0 12px;
  font-size:var(--dpr-font-xs);
  line-height:1.55;
  text-align:left;
}
.dpr-heroTags{
  display:flex;
  flex-wrap:wrap;
  gap:5px;
}
.dpr-heroTag{
  display:inline-flex;
  align-items:center;
  min-height:23px;
  padding:2px 7px;
  color:var(--dpr-ink-secondary);
  background:var(--dpr-surface-raised);
  border:1px solid var(--dpr-line);
  border-radius:999px;
  font-size:9px;
  font-weight:700;
}
.dpr-heroTag.is-brand{
  color:var(--dpr-link);
  background:color-mix(in srgb,var(--dpr-brand) 12%,var(--dpr-surface-raised));
}
.dpr-mascotSticker{
  position:relative;
  z-index:1;
  justify-self:end;
  padding:6px 6px 7px;
  background:color-mix(in srgb,var(--dpr-warn) 12%,var(--dpr-surface-raised));
  border:2px solid var(--dpr-line-strong);
  border-radius:20px 7px 20px 7px;
  box-shadow:var(--dpr-shadow-raised);
  transform:rotate(2deg);
}
.dpr-mascotSticker .dpr-mascot{
  display:block;
  width:108px;
  height:108px;
  max-width:none;
  padding:0;
  object-fit:cover;
  border:0;
  border-radius:14px 4px 14px 4px;
  box-shadow:none;
  transform:none;
}
.dpr-mascotSticker span{
  display:block;
  margin-top:5px;
  color:var(--dpr-ink-secondary);
  font-size:8px;
  line-height:1.25;
  font-weight:750;
  text-align:center;
  letter-spacing:.03em;
}

.dpr-card::before{content:none}
.dpr-cardTop{
  display:flex;
  align-items:flex-start;
  justify-content:space-between;
  width:100%;
  gap:6px;
}
.dpr-cardIndex{
  color:var(--dpr-ink-tertiary);
  font-family:var(--dsw-font-mono,ui-monospace,monospace);
  font-size:9px;
  letter-spacing:.04em;
}
.dpr-card .dpr-cardArt{margin-bottom:2px}
.dpr-surveyCard{
  display:grid;
  grid-template-columns:38px minmax(0,1fr) auto;
  align-items:center;
}
.dpr-surveyHead{
  display:contents;
}
.dpr-surveyList{grid-column:1 / -1}
.dpr-surveyCard > .dpr-cardDesc{grid-column:2}
.dpr-surveyCard > .dpr-cardGo{grid-column:3;white-space:nowrap}

.dpr-importContent{
  width:100%;
  height:100%;
  max-width:452px;
  margin:0 auto;
  padding:18px 18px 28px;
  overflow:auto;
}
.dpr-load{
  width:100%;
  max-width:452px;
  margin:0 auto;
  padding-top:12px;
}
.dpr-loadHero{
  display:grid;
  grid-template-columns:minmax(0,1fr);
  justify-items:center;
  align-items:center;
  gap:16px;
  width:100%;
  text-align:center;
}
.dpr-loadHero .dpr-mascotSlot{
  box-sizing:border-box;
  min-width:0;
  min-height:216px;
  width:100%;
  padding:0;
  overflow:visible;
  background:none;
  border:0;
  border-radius:0;
}
.dpr-loadHero .dpr-mascotSlot::before{display:none}
.dpr-loadHero .dpr-mascotSlot img{max-width:216px}
.dpr-loadCopy{min-width:0}
.dpr-loadCopy .dpr-question{margin:0 0 6px;font-size:var(--dpr-font-title);text-align:center}
.dpr-loadCopy .dpr-sub{margin:0;text-align:center}
.dpr-pageTopbar{
  flex:none;
  display:flex;
  align-items:center;
  gap:9px;
  min-height:48px;
  padding:0 14px;
  background:color-mix(in srgb,var(--dpr-surface-raised) 94%,var(--dpr-brand));
  border-bottom:1px solid var(--dpr-line);
}
.dpr-pageBack{
  min-height:30px;
  padding:3px 8px;
  font-size:var(--dpr-font-xs);
}
.dpr-pageCrumb{
  min-width:0;
  flex:1;
  overflow:hidden;
  color:var(--dpr-ink-tertiary);
  font-size:var(--dpr-font-xs);
  text-overflow:ellipsis;
  white-space:nowrap;
}
.dpr-pageCrumb b{color:var(--dpr-ink);font-weight:750}
.dpr-pageLocal{
  flex:none;
  padding:2px 6px;
  color:var(--dpr-ink-tertiary);
  background:var(--dpr-surface-soft);
  border:1px solid var(--dpr-line);
  border-radius:5px;
  font-family:var(--dsw-font-mono,ui-monospace,monospace);
  font-size:8px;
  letter-spacing:.06em;
}
.dpr-importHero{
  display:grid;
  grid-template-columns:minmax(0,1fr) 104px;
  align-items:center;
  gap:16px;
  margin-bottom:24px;
}
.dpr-importHeroCopy .dpr-question{
  margin:0 0 5px;
  font-size:calc(var(--dpr-font-title) + 2px);
  line-height:1.25;
  text-align:left;
}
.dpr-importHeroCopy .dpr-sub{margin:0;text-align:left}
.dpr-importMascot .dpr-mascot{
  display:block;
  width:96px;
  height:96px;
  max-width:none;
  padding:0;
  object-fit:contain;
}
.dpr-stepper{
  display:grid;
  grid-template-columns:repeat(3,1fr);
  margin-bottom:13px;
  padding:5px;
  background:var(--dpr-surface-soft);
  border:1px solid var(--dpr-line);
  border-radius:9px;
}
.dpr-step{
  display:flex;
  align-items:center;
  justify-content:center;
  gap:5px;
  min-height:27px;
  color:var(--dpr-ink-tertiary);
  font-size:9px;
  font-weight:650;
}
.dpr-step + .dpr-step{border-left:1px solid var(--dpr-line)}
.dpr-step i{
  width:7px;
  height:7px;
  background:var(--dpr-line);
  border:1px solid var(--dpr-line-strong);
  border-radius:50%;
}
.dpr-step.is-active{color:var(--dpr-ink)}
.dpr-step.is-active i{background:var(--dpr-brand)}
.dpr-import{max-width:none}
.dpr-drop{min-height:214px}
.dpr-fileCard{
  display:grid;
  grid-template-columns:34px minmax(0,1fr) auto;
  align-items:center;
  gap:9px;
  padding:9px 10px;
  background:var(--dpr-surface-raised);
  border:1px solid var(--dpr-line);
  border-radius:8px;
}
.dpr-fileGlyph{
  display:grid;
  place-items:center;
  width:31px;
  height:35px;
  color:var(--dpr-link);
  background:color-mix(in srgb,var(--dpr-brand) 12%,var(--dpr-surface-raised));
  border:1px solid var(--dpr-line);
  border-radius:5px;
  font-family:var(--dsw-font-mono,ui-monospace,monospace);
  font-size:8px;
  font-weight:800;
}
.dpr-fileBody{min-width:0}
.dpr-fileBody b,.dpr-fileBody small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dpr-fileBody b{color:var(--dpr-ink);font-size:var(--dpr-font-xs)}
.dpr-fileBody small{margin-top:2px;color:var(--dpr-ink-tertiary);font-size:9px}
.dpr-fileChange{
  min-height:27px;
  padding:3px 7px;
  color:var(--dpr-ink-secondary);
  background:var(--dpr-surface-soft);
  border:1px solid var(--dpr-line);
  border-radius:999px;
  font-size:9px;
  cursor:pointer;
}

.dpr-readerBar{align-items:center}
.dpr-readerDocHeading{
  min-width:0;
  flex:1 1 220px;
  display:flex;
  flex-direction:column;
  gap:2px;
}
.dpr-readerKicker{
  overflow:hidden;
  color:var(--dpr-ink-tertiary);
  font-family:var(--dsw-font-mono,ui-monospace,monospace);
  font-size:8px;
  line-height:1.3;
  letter-spacing:.06em;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.dpr-readerBarTitle{display:block;flex:none;font-size:var(--dpr-font-xs)}
.dpr-readerBody{width:100%;max-width:none;padding:18px clamp(16px,2vw,32px) 74px}
.dpr-readerLayout{
  display:grid;
  grid-template-columns:clamp(176px,16vw,244px) minmax(0,1fr);
  align-items:start;
  gap:16px;
  width:100%;
  max-width:1470px;
  margin:0 auto;
}
.dpr-readerOutline{
  position:sticky;
  top:var(--dpr-outline-top,12px);
  padding:11px;
  background:color-mix(in srgb,var(--dpr-surface-raised) 92%,transparent);
  border:1px solid var(--dpr-line);
  border-radius:9px;
}
.dpr-readerOutline h3{
  margin:0 0 8px;
  color:var(--dpr-ink-tertiary);
  font-family:var(--dsw-font-mono,ui-monospace,monospace);
  font-size:8px;
  letter-spacing:.07em;
}
.dpr-readerOutline nav{display:grid;gap:2px}
.dpr-readerOutlineItem{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:5px;
  min-width:0;
  padding:6px 7px;
  text-align:left;
  color:var(--dpr-ink-tertiary);
  background:transparent;
  border:0;
  border-left:2px solid transparent;
  border-radius:0 5px 5px 0;
  font-size:9px;
  line-height:1.35;
  cursor:pointer;
}
.dpr-readerOutlineItem span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dpr-readerOutlineItem small{flex:none;font-size:8px;opacity:.72}
.dpr-readerOutlineItem:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dpr-ink)}
.dpr-readerOutlineItem.is-active{
  color:var(--dpr-link);
  background:color-mix(in srgb,var(--dpr-brand) 10%,var(--dpr-surface-raised));
  border-left-color:var(--dpr-brand);
  font-weight:750;
}
.dpr-readerArticle{
  min-width:0;
  width:100%;
  max-width:1180px;
  padding:28px 30px 44px;
  background:var(--dpr-surface-raised);
  border:1px solid var(--dpr-line);
  border-radius:8px;
  box-shadow:3px 3px 0 color-mix(in srgb,var(--dpr-ink) 10%,transparent);
}
.dpr-readerArticleKicker{
  display:flex;
  align-items:center;
  gap:8px;
  margin-bottom:12px;
  color:var(--dpr-link);
  font-family:var(--dsw-font-mono,ui-monospace,monospace);
  font-size:8px;
  font-weight:800;
  letter-spacing:.07em;
}
.dpr-readerArticleKicker::after{
  content:"";
  flex:1;
  height:1px;
  background:var(--dpr-line);
}
.dpr-readerTitle{
  margin:0 0 9px;
  font-size:calc(var(--dpr-font-title) + 6px);
  letter-spacing:-.012em;
}
.dpr-readerBadges{margin-bottom:18px}
.dpr-readerAbstract{
  margin:18px 0 24px;
  border-radius:8px;
}

.dpr-cmpHeadActions{gap:6px}
.dpr-cmpMetric{
  display:inline-flex;
  align-items:center;
  gap:4px;
  padding:3px 7px;
  color:var(--dpr-ink-tertiary);
  background:var(--dpr-surface-raised);
  border:1px solid var(--dpr-line);
  border-radius:999px;
  font-size:9px;
  white-space:nowrap;
}
.dpr-cmpMetric b{color:var(--dpr-ink);font-size:10px}
.dpr-cmpPapers .dpr-cmpPaperPane:first-child{border-top:3px solid var(--dpr-brand)}
.dpr-cmpPapers .dpr-cmpPaperPane:nth-child(2){border-top:3px solid var(--dpr-warn)}
.dpr-cmpWorkspace{
  background:var(--dpr-surface-raised);
  box-shadow:var(--dpr-shadow-card);
}

@media (max-width:720px){
  .dpr-readerLayout{grid-template-columns:1fr}
  .dpr-readerOutline{
    position:static;
    display:flex;
    gap:8px;
    overflow:auto;
    align-items:center;
  }
  .dpr-readerOutline h3{flex:none;margin:0}
  .dpr-readerOutline nav{display:flex;gap:4px}
  .dpr-readerOutlineItem{flex:none;border-left:0;border:1px solid var(--dpr-line);border-radius:999px}
  .dpr-readerArticle{padding:22px 20px 38px}
}
@media (max-width:420px){
  .dpr-homeCol,.dpr-importContent{padding-inline:12px}
  .dpr-homeHero{grid-template-columns:minmax(0,1fr) 88px;padding:16px 12px}
  .dpr-mascotSticker .dpr-mascot{width:72px;height:72px}
  .dpr-importHero{grid-template-columns:minmax(0,1fr) 88px;gap:12px}
  .dpr-importMascot .dpr-mascot{width:80px;height:80px}
  .dpr-homeHero .dpr-question{font-size:20px}
  .dpr-heroTags .dpr-heroTag:last-child{display:none}
  .dpr-card{min-height:158px;padding-inline:10px}
  .dpr-surveyCard{grid-template-columns:34px minmax(0,1fr)}
  .dpr-surveyCard > .dpr-cardGo{grid-column:2}
  .dpr-readerBody{padding:14px 10px 62px}
  .dpr-readerArticle{padding:20px 16px 34px}
  .dpr-readerTitle{font-size:22px}
}

/* Transparent state illustrations: the page surface supplies the background. */
.dpr-mascot.is-transparent,
.dpr-mascotSticker .dpr-mascot.is-transparent,
.dpr-loadHero .dpr-mascotSlot .dpr-mascot.is-transparent,
.dpr-importMascot .dpr-mascot.is-transparent{
  padding:0;
  object-fit:contain;
  background:transparent;
  border:0;
  border-radius:0;
  box-shadow:none;
  transform:none;
  animation:none;
  image-rendering:pixelated;
}
body[data-ds-dark-theme] .dpr-mascotSticker{
  background:color-mix(in srgb,var(--dpr-brand) 14%,var(--dpr-surface-raised));
  border-color:color-mix(in srgb,var(--dpr-brand) 42%,var(--dpr-line-strong));
  box-shadow:3px 3px 0 color-mix(in srgb,var(--dpr-brand) 22%,transparent);
}
.dpr-mascotSprite{
  position:relative;
  display:block;
  flex:none;
  overflow:hidden;
  line-height:0;
  background:transparent;
  contain:layout paint;
}
.dpr-mascotSlot .dpr-mascotSprite{
  margin-inline:auto;
}
.dpr-mascotSprite .dpr-mascotSpriteImage{
  display:block;
  width:auto!important;
  max-width:none!important;
  height:100%!important;
  padding:0;
  object-fit:contain;
  background:transparent;
  border:0;
  border-radius:0;
  box-shadow:none;
  image-rendering:pixelated;
  transform:translate3d(0,0,0);
  will-change:transform;
}
.dpr-mascotSprite--loading .dpr-mascotSpriteImage{
  animation:dpr-mascot-loading-sprite 980ms steps(1,end) infinite;
}
.dpr-mascotSprite--success .dpr-mascotSpriteImage{
  animation:dpr-mascot-success-sprite 1180ms steps(1,end) 1 forwards;
}
@keyframes dpr-mascot-loading-sprite{
  0%{transform:translate3d(0,0,0)}
  24.49%{transform:translate3d(var(--dpr-sprite-frame-1),0,0)}
  36.73%{transform:translate3d(var(--dpr-sprite-frame-2),0,0)}
  48.98%{transform:translate3d(var(--dpr-sprite-frame-3),0,0)}
  61.22%{transform:translate3d(var(--dpr-sprite-frame-4),0,0)}
  73.47%{transform:translate3d(var(--dpr-sprite-frame-5),0,0)}
}
@keyframes dpr-mascot-success-sprite{
  0%{transform:translate3d(0,0,0)}
  10.17%{transform:translate3d(var(--dpr-sprite-frame-1),0,0)}
  20.34%{transform:translate3d(var(--dpr-sprite-frame-2),0,0)}
  30.51%{transform:translate3d(var(--dpr-sprite-frame-3),0,0)}
  40.68%{transform:translate3d(var(--dpr-sprite-frame-4),0,0)}
}
.dpr-readerMascotError{
  display:flex;
  flex-direction:column;
  align-items:center;
  gap:12px;
  width:100%;
  padding:18px 0;
}
.dpr-readerMascotError .dpr-mascot{
  width:156px;
  max-width:42vw;
  height:auto;
}
.dpr-readerMascotError .dpr-error{
  width:min(100%,560px);
  box-sizing:border-box;
}
@media (prefers-reduced-motion:reduce){
  .dpr-mascotSprite .dpr-mascotSpriteImage{
    animation:none;
    will-change:auto;
  }
  .dpr-mascotSprite--loading .dpr-mascotSpriteImage{
    transform:translate3d(0,0,0);
  }
  .dpr-mascotSprite--success .dpr-mascotSpriteImage{
    transform:translate3d(var(--dpr-sprite-frame-4),0,0);
  }
}
`

    const STYLE_TAG_ID = 'dsh-doraemon-paper-reader/client.css'
    if (
      typeof document !== 'undefined' &&
      document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_TAG_ID) + ']') === null
    ) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-doraemon-paper-reader'
      tag.dataset.pluginCss = STYLE_TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    //#endregion

    //#region 像素美术：色板 + 网格 + 行合并（只服务入口的两枚小图标）
    //
    // 色值取自 docs/界面风格-v0.md §2.1（对定稿主形象 UI/mascot-v1.png 的逐像素实测）。
    // 网格按 1 逻辑像素一格、整数倍放大（§3：非整数缩放直接判不合格）。

    const PALETTE = {
      o: '#10101A', // 墨蓝黑：1px 描边
      b: '#428AC7', // 主蓝
      l: '#5493BB', // 亮蓝（受光侧）
      d: '#2D365C', // 深蓝（背光侧 / 披风）
      w: '#F6F6EE', // 白：猫脸面板、荷叶边
      r: '#BC4C3C', // 红鼻头
      c: '#7CACC4', // 青：镜片
    }

    /**
     * 吉祥物插画：主形象定稿的小号 Web 资产，由宿主半区的
     * `/doraemon-paper-reader/assets/*` 路由发出去（不内联 base64、不引外部 CDN）。
     * 相对地址（不带前导斜杠）：前端静态服务会把文档 base 冻在入口目录上，
     * 这样在代理挂到子路径时也能解析对（与宿主的 `plugins/…` 行同一套规则）。
     */
    const MASCOT_ASSETS = Object.freeze({
      homeOpenBook: 'doraemon-paper-reader/assets/mascot/action-v1/home-open-book-transparent-v1.webp',
      loadingTurnPage:
        'doraemon-paper-reader/assets/mascot/action-v1/loading-turn-page-transparent-v1.webp',
      successYay: 'doraemon-paper-reader/assets/mascot/action-v1/success-yay-transparent-v1.webp',
      errorPlayDead: 'doraemon-paper-reader/assets/mascot/action-v1/error-play-dead-transparent-v1.webp',
      lookupDetective: 'doraemon-paper-reader/assets/mascot/action-v1/lookup-detective-transparent-v1.webp',
      stackBooks: 'doraemon-paper-reader/assets/mascot/action-v1/stack-books-transparent-v1.webp',
      readLying: 'doraemon-paper-reader/assets/mascot/action-v1/read-lying-transparent-v1.webp',
      annotate: 'doraemon-paper-reader/assets/mascot/remaining-v1/annotate.webp',
      dictionary: 'doraemon-paper-reader/assets/mascot/remaining-v1/dict.webp',
      offline: 'doraemon-paper-reader/assets/mascot/remaining-v1/offline.webp',
      sleep: 'doraemon-paper-reader/assets/mascot/remaining-v1/sleep.webp',
      readSofa: 'doraemon-paper-reader/assets/mascot/remaining-v1/read-sofa.webp',
      badge: 'doraemon-paper-reader/assets/mascot/remaining-v1/badge.webp',
    })

    const MASCOT_SRC = MASCOT_ASSETS.homeOpenBook

    const MASCOT_SPRITES = Object.freeze({
      loading: Object.freeze({
        src: 'doraemon-paper-reader/assets/mascot/action-v1/loading-turn-page-transparent-sprite-v1.webp',
        frames: 6,
        className: 'dpr-mascotSprite--loading',
        altKey: 'art.mascot.loading',
      }),
      success: Object.freeze({
        src: 'doraemon-paper-reader/assets/mascot/action-v1/success-yay-transparent-sprite-v1.webp',
        frames: 5,
        className: 'dpr-mascotSprite--success',
        altKey: 'art.mascot.success',
      }),
    })

    const PROP_ASSETS = Object.freeze({
      hourglass: 'doraemon-paper-reader/assets/props/v1/hourglass.webp',
      magnifierEmpty: 'doraemon-paper-reader/assets/props/v1/magnifier-empty.webp',
      magnifierFound: 'doraemon-paper-reader/assets/props/v1/magnifier-found.webp',
      highlighter: 'doraemon-paper-reader/assets/props/v1/highlighter.webp',
      annotationBubble: 'doraemon-paper-reader/assets/props/v1/annotation-bubble.webp',
      citationChain: 'doraemon-paper-reader/assets/props/v1/citation-chain.webp',
      versionLayers: 'doraemon-paper-reader/assets/props/v1/version-layers.webp',
      tableGrid: 'doraemon-paper-reader/assets/props/v1/table-grid.webp',
      chartBars: 'doraemon-paper-reader/assets/props/v1/chart-bars.webp',
      formulaSymbol: 'doraemon-paper-reader/assets/props/v1/formula-symbol.webp',
      dictionary: 'doraemon-paper-reader/assets/props/v1/dictionary.webp',
      offlinePlug: 'doraemon-paper-reader/assets/props/v1/offline-plug.webp',
      toolbox: 'doraemon-paper-reader/assets/props/v1/toolbox.webp',
      bookStackSmall: 'doraemon-paper-reader/assets/props/v1/book-stack-small.webp',
      successSeal: 'doraemon-paper-reader/assets/props/v1/success-seal.webp',
    })

    /** 「PDF 文件」入口图标（16×16 像素稿：一页纸 + 折角 + 文字行）。 */
    const ICON_DOC = [
      '................',
      '...ooooooooo....',
      '...owwwwwwwdo...',
      '...owwwwwwwwo...',
      '...owwwwwwwwo...',
      '...owbbbbbbwo...',
      '...owwwwwwwwo...',
      '...owbbbbbbwo...',
      '...owwwwwwwwo...',
      '...owbbbbwwwo...',
      '...owwwwwwwwo...',
      '...owbbbbbbwo...',
      '...owwwwwwwwo...',
      '...owwwwwwwwo...',
      '...oooooooooo...',
      '................',
    ]

    /** 「信息查询」入口图标（16×16 像素稿：放大镜）。 */
    const ICON_QUERY = [
      '................',
      '................',
      '................',
      '.....oooo.......',
      '....occcco......',
      '...ocwcccco.....',
      '...owccccco.....',
      '...occcccco.....',
      '...occcccco.....',
      '...occcccco.....',
      '....occccoo.....',
      '.....oooo.oo....',
      '...........oo...',
      '............oo..',
      '.............oo.',
      '................',
    ]

    /**
     * 把一行像素合并成同色横条，少发 DOM 节点（纯函数，L0 有覆盖）。
     * @param {readonly string[]} map - 等高、等宽的像素行（`.` 表示透明）。
     * @returns {{x:number,y:number,w:number,color:string}[]} 按行优先的横条。
     */
    function runs(map) {
      const out = []
      map.forEach((row, y) => {
        let x = 0
        while (x < row.length) {
          const color = row[x]
          if (color === '.') {
            x += 1
            continue
          }
          let w = 1
          while (x + w < row.length && row[x + w] === color) w += 1
          out.push({ x, y, w, color })
          x += w
        }
      })
      return out
    }

    /**
     * 渲染一份像素稿：viewBox 用网格坐标，宽高用整数倍逻辑像素（§3）。
     * @param {readonly string[]} map - 像素行。
     * @param {number} scale - 整数倍放大。
     * @param {string} label - 无障碍名称（§8：插画必须给 alt）。
     * @param {string} [className] - 额外类名。
     * @returns {object} React 元素。
     */
    function art(map, scale, label, className) {
      const width = map[0].length
      const height = map.length
      return React.createElement(
        'svg',
        {
          className,
          width: width * scale,
          height: height * scale,
          viewBox: '0 0 ' + width + ' ' + height,
          role: 'img',
          'aria-label': label,
          shapeRendering: 'crispEdges',
          style: { display: 'block' },
        },
        runs(map).map((run, index) =>
          React.createElement('rect', {
            key: index,
            x: run.x,
            y: run.y,
            width: run.w,
            height: 1,
            fill: PALETTE[run.color],
          }),
        ),
      )
    }

    /**
     * 引导页胶囊的图标：走 currentColor 跟宿主同色（不拿我们的品牌色污染宿主 chrome）。
     * @param {{size?: number, className?: string}} props - 宿主 IconProps。
     * @returns {object} React 元素。
     */
    function PluginIcon(props) {
      const size = props.size === undefined ? 20 : props.size
      return React.createElement(
        'svg',
        {
          className: props.className,
          width: size,
          height: size,
          viewBox: '0 0 20 20',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        React.createElement('path', { d: 'M5 2.5h5.5L15 7v10.5H5z' }),
        React.createElement('path', { d: 'M10.5 2.5V7H15' }),
        React.createElement('path', { d: 'M7.5 10.5h5' }),
        React.createElement('path', { d: 'M7.5 13.5h3' }),
      )
    }

    //#endregion

    //#region 两条路径的文案键（结构在这里，文字在字典里）

    const PATHS = [
      {
        id: 'file',
        kind: 'doraemon-paper-file',
        icon: ICON_DOC,
        iconAltKey: 'art.doc.alt',
        titleKey: 'path.file.title',
        descKey: 'path.file.desc',
        headingKey: 'path.file.heading',
        leadKey: 'path.file.lead',
        itemKeys: ['path.file.item1', 'path.file.item2', 'path.file.item3'],
      },
      {
        id: 'lookup',
        kind: 'doraemon-paper-lookup',
        icon: ICON_QUERY,
        iconAltKey: 'art.query.alt',
        titleKey: 'path.lookup.title',
        descKey: 'path.lookup.desc',
        headingKey: 'path.lookup.heading',
        leadKey: 'path.lookup.lead',
        itemKeys: ['path.lookup.item1', 'path.lookup.item2', 'path.lookup.item3'],
      },
    ]

    //#endregion

    //#region 文案字典（zh / en 必须键集一致，L0 有断言）

    const DICT_ZH = {
      'type.home': '论文阅读器',
      'guide.title': '论文阅读器',
      'guide.description': '把论文交给小的我：本地 PDF，或 DOI / arXiv 号',
      'home.question': '陛下要小的我如何取来论文',
      'home.sub': '小的我更推荐 PDF 途径哦，陛下~',
      'home.eyebrow': '阅读桌',
      'home.tagPdf': 'PDF',
      'home.tagDoi': 'DOI',
      'home.tagArxiv': 'arXiv',
      'home.recent': '最近论文',
      'home.refresh': '刷新',
      'home.maintenance': '环境与存储',
      'home.mascotCaption': '在下大肥鱼，请指教',
      'home.note': '单篇精读走上面两条路；要比多篇，就用下面的「多篇综述」。',
      'path.file.title': 'PDF 文件',
      'path.file.desc': '把论文交给小的我',
      'path.lookup.title': '信息查询',
      'path.lookup.desc': '只给 DOI 或 arXiv 号，小的我去找',
      'path.open': '进去看看 →',
      'path.file.heading': '把论文交给小的我',
      'path.file.lead': '陛下选一份 PDF，小的我抄成可读的 HTML。',
      'path.file.item1': '只读 PDF 文本层；图、表、公式按原页搬运',
      'path.file.item2': '每个块带页码与位置戳，原版页留着核对',
      'path.file.item3': '关掉页签也在后台抄，只要 DSH 还开着',
      'path.lookup.heading': '找论文这条路，小的我还在铺',
      'path.lookup.lead': '陛下先看看小的我打算怎么走：',
      'path.lookup.item1': '陛下给 DOI、arXiv 号或标题，小的我先认出是哪一篇',
      'path.lookup.item2': '小的我去公开渠道捞回来读（arXiv / ar5iv），付费墙不碰',
      'path.lookup.item3': '捞不到就老实说为什么，不硬闯',
      'path.back': '回到主界面',
      'path.wip': '这一页还没有真东西，小的我先把位置占上',
      'import.title': '把论文交给小的我',
      'import.lead': '陛下选一份 PDF，小的我这就抄成可读的 HTML。',
      'import.eyebrow': '导入桌',
      'import.dropTitle': '把 PDF 拖到这里',
      'import.dropHint': '或点一下，仅选 PDF；文件不会离开这台电脑。',
      'import.choose': '选择 PDF 文件',
      'import.selected': '已选好：',
      'import.start': '大肥鱼给朕速速抄写！！！',
      'import.onlyPdf': '小的我只收 PDF，陛下换一份吧。',
      'import.tooLarge': '这份 PDF 超过 200 MB，小的我搬不动。',
      'import.uploading': '小的我正在接住 PDF…',
      'import.uploadFailed': '小的我没接住：',
      'import.stage.queued': '排队',
      'import.stage.fetch': '从合法渠道取回原文',
      'import.stage.extract': '整理 HTML 结构',
      'import.stage.read': '读取 PDF 文本层',
      'import.stage.classify': '分类标题、正文与题注',
      'import.stage.assets': '寻找图、表与公式',
      'import.stage.crop': '搬出图、表与公式',
      'import.stage.pages': '备好原版页',
      'import.stage.mirror': '整理 MirrorDoc',
      'import.stage.verify': '复核表格与原版页',
      'import.stage.render': '排版 HTML',
      'import.stage.done': '抄写完成',
      'import.stage.failed': '抄写失败',
      'import.timer': '小的我已经抄了',
      'import.background': '陛下可以先去做别的；关掉这个页签，小的我也会继续抄。',
      'import.stepChoose': '选择论文',
      'import.stepCopy': '抄写版面',
      'import.stepRead': '开始精读',
      'import.local': '本地',
      'import.waitingFile': '等待抄写',
      'import.change': '更换',
      'import.openReader': '打开阅读页',
      'import.resume': '接着看上次的抄写',
      'import.newFile': '换一份 PDF',
      'import.animationSlot': '大肥鱼正在一页页翻书',
      'import.wait': '陛下稍候，小的我正在抄。',
      'import.done': '陛下，抄好了。',
      'import.failed': '陛下，小的我没抄成：',
      'reader.title': '论文阅读',
      'reader.loading': '小的我正在把抄好的页面搬过来…',
      'reader.failed': '页面没搬过来：',
      'reader.back': '回到 PDF 入口',
      'reader.outline': '本文目录',
      'reader.coverage': '正文覆盖',
      'reader.versionUnknown': '版本未核验',
      'reader.page': '原版 p.',
      'reader.abstract': '摘要',
      'reader.keywords': '关键词',
      'reader.figures': '图',
      'reader.tables': '表',
      'reader.equations': '公式',
      'reader.references': '参考文献',
      'reader.noDoc': '还没有抄好的论文。',
      'reader.openHtml': '在新标签打开 HTML',
      'reader.lang.original': '原文',
      'reader.lang.zh': '中文',
      'reader.lang.bilingual': '对照',
      'reader.lang.switch': '切换语言：原文 → 中文 → 对照',
      'reader.ask': '问大肥鱼',
      'reader.askHint': '带上标题、版本、页码和前后文',
      'reader.askSent': '已经打包给小的我，陛下去对话里看回答。',
      'reader.askFailed': '没送出去：',
      'reader.askNoSession': '还没有打开的会话。',
      'reader.askPlaceholder': '写下你的批注或问题…',
      'reader.notePlaceholder': '给这条批注写点什么',
      'reader.added': '已加入批注，去对话里改问题并发送。',
      'reader.return': '回到阅读',
      'home.surveyTitle': '多篇综述',
      'home.surveyDesc': '把两三篇放在一起，按同一张表比',
      'home.surveyGo': '开始对照 →',
      'survey.title': '陛下要拿哪几篇来对照',
      'survey.lead': '选 2–3 篇；小的我只抽摘要、章节和关键段，不把整篇重传。',
      'survey.pick': '点一下选中',
      'survey.selected': '已选 ',
      'survey.start': '开始对照',
      'survey.limit': '一次最多 3 篇；先取消一篇再选。',
      'survey.empty': '论文库里还没有可对照的论文，先抄一篇进来吧。',
      'survey.back': '回到主界面',
      'compare.surveyTitle': '多篇综述',
      'compare.citationTitle': '引用对照',
      'compare.close': '关闭',
      'compare.loading': '小的我正在压缩论文档案…',
      'compare.loadFailed': '档案没读出来：',
      'compare.sections': '章节',
      'compare.counts': '规模',
      'compare.openReader': '打开阅读页',
      'compare.table': '对照表',
      'compare.generate': '生成对照表',
      'compare.regenerating': '小的我正在对照…',
      'compare.tableEmpty': '还没有对照表。点「生成对照表」，小的我按七个字段把几篇摆在一起。',
      'compare.ask': '一起问',
      'compare.askPlaceholder': '想让大肥鱼重点比什么？（可留空）',
      'compare.askSend': '把这几篇一起交给主对话',
      'compare.sending': '正在打包对照包…',
      'compare.sent': '已送到主对话；主输入框里能看到这条对照消息。',
      'compare.judge': '判断支持关系',
      'compare.judging': '小的我在核对引用链…',
      'compare.citing': '引用处',
      'compare.backCite': '回到引用处',
      'compare.evidence': '依据',
      'compare.verdict': '支持度',
      'compare.noTable': '没有对照表',
      'compare.ungrounded': '未定位',
      'compare.papers': '篇',
      'compare.question': '整体问题',
      'compare.stats': '已定位 ',
      'compare.toolHint': '主对话会调用 doraemon_read_papers 读取这几篇的精简档案。',
      'art.mascot.alt': '戴着蓝色鲸鱼兜帽的大肥鱼：兜帽上有一张白猫脸面板，长发与披风都是深海蓝，正面站着等陛下选一条路',
      'art.mascot.home': '大肥鱼双手捧着一本打开的书，认真看着陛下，等待选择论文入口',
      'art.mascot.loading': '大肥鱼站着认真翻动书页，表示论文正在抄写或查询',
      'art.mascot.success': '大肥鱼举起左手喊“好耶”，右手仍稳稳抱着书，表示任务完成',
      'art.mascot.error': '大肥鱼保持抱书姿势，眼睛变成叉号、松垮地装死，表示任务失败',
      'art.mascot.lookup': '大肥鱼戴猎鹿帽和单片眼镜，手持放大镜与记事本，准备查找论文线索',
      'art.mascot.stack': '大肥鱼双手托住一摞厚重的童话书，表示论文库还是空的',
      'art.mascot.readerError': '大肥鱼趴在地上扶着打开的书，表示这一页暂时无法阅读',
      'art.doc.alt': '一页论文 PDF 的像素图标',
      'art.query.alt': '一只放大镜的像素图标',
    }

    const DICT_EN = {
      'type.home': 'Paper reader',
      'guide.title': 'Paper reader',
      'guide.description': 'Give little old me a paper: a local PDF, or a DOI / arXiv ID',
      'home.question': 'How would Your Majesty have little old me fetch the paper',
      'home.sub': 'This little one recommends the PDF route, Your Majesty~',
      'home.eyebrow': 'Reading desk',
      'home.tagPdf': 'PDF',
      'home.tagDoi': 'DOI',
      'home.tagArxiv': 'arXiv',
      'home.recent': 'Recent papers',
      'home.refresh': 'Refresh',
      'home.maintenance': 'Environment & storage',
      'home.mascotCaption': 'At your service - Big Fatty Fish',
      'home.note': 'Use the two routes above for one paper; use “Literature review” below to compare several.',
      'path.file.title': 'PDF file',
      'path.file.desc': 'Hand the paper to little old me',
      'path.lookup.title': 'Look it up',
      'path.lookup.desc': 'Give a DOI or arXiv ID and little old me will find it',
      'path.open': 'Take a look →',
      'path.file.heading': 'Hand the paper to little old me',
      'path.file.lead': 'Choose a PDF, Your Majesty, and little old me will copy it into readable HTML.',
      'path.file.item1': 'Read the PDF text layer; carry figures, tables and equations over from the source page',
      'path.file.item2': 'Keep a page number and position stamp on every block; keep the original page for checking',
      'path.file.item3': 'Keep copying in the background after the tab closes, as long as DSH stays open',
      'path.lookup.heading': 'This little one is still paving the lookup path',
      'path.lookup.lead': 'Here is what little old me plans:',
      'path.lookup.item1': 'Give a DOI, arXiv ID or title, and little old me will work out which paper it is',
      'path.lookup.item2': 'Fetch a readable copy from open channels (arXiv / ar5iv), never paywalls',
      'path.lookup.item3': 'If it cannot be found, say why plainly instead of forcing the way in',
      'path.back': 'Back to the start',
      'path.wip': 'Nothing real lives here yet — little old me is holding the spot',
      'import.title': 'Hand the paper to little old me',
      'import.lead': 'Choose a PDF, Your Majesty; little old me will copy it into readable HTML.',
      'import.eyebrow': 'Import desk',
      'import.dropTitle': 'Drop the PDF here',
      'import.dropHint': 'Or click to choose a PDF only. The file stays on this computer.',
      'import.choose': 'Choose a PDF file',
      'import.selected': 'Selected: ',
      'import.start': 'Big Fatty Fish, copy it for Us at once!!!',
      'import.onlyPdf': 'This little one only takes PDFs, Your Majesty.',
      'import.tooLarge': 'This PDF is over 200 MB; little old me cannot carry it.',
      'import.uploading': 'This little one is catching the PDF…',
      'import.uploadFailed': 'This little one missed it: ',
      'import.stage.queued': 'Queued',
      'import.stage.fetch': 'Fetching from a lawful source',
      'import.stage.extract': 'Extracting the HTML structure',
      'import.stage.read': 'Reading the PDF text layer',
      'import.stage.classify': 'Classifying headings, prose and captions',
      'import.stage.assets': 'Finding figures, tables and equations',
      'import.stage.crop': 'Carrying out figures, tables and equations',
      'import.stage.pages': 'Preparing the original pages',
      'import.stage.mirror': 'Building MirrorDoc',
      'import.stage.verify': 'Reconciling tables against the source pages',
      'import.stage.render': 'Laying out HTML',
      'import.stage.done': 'Copying finished',
      'import.stage.failed': 'Copying failed',
      'import.timer': 'This little one has been copying for',
      'import.background': 'Your Majesty may go elsewhere; closing this tab will not stop the copying.',
      'import.stepChoose': 'Choose paper',
      'import.stepCopy': 'Copy layout',
      'import.stepRead': 'Start reading',
      'import.local': 'LOCAL',
      'import.waitingFile': 'Waiting to copy',
      'import.change': 'Replace',
      'import.openReader': 'Open the reading page',
      'import.resume': 'Resume the last copy',
      'import.newFile': 'Choose another PDF',
      'import.animationSlot': 'Big Fatty Fish is turning the pages',
      'import.wait': 'Please wait, Your Majesty; little old me is copying.',
      'import.done': 'It is copied, Your Majesty.',
      'import.failed': 'This little one could not copy it, Your Majesty: ',
      'reader.title': 'Paper reading',
      'reader.loading': 'This little one is carrying the copied page over…',
      'reader.failed': 'The page did not arrive: ',
      'reader.back': 'Back to the PDF entrance',
      'reader.outline': 'On this paper',
      'reader.coverage': 'Body coverage',
      'reader.versionUnknown': 'Version unverified',
      'reader.page': 'Original p.',
      'reader.abstract': 'Abstract',
      'reader.keywords': 'Keywords',
      'reader.figures': 'Figures',
      'reader.tables': 'Tables',
      'reader.equations': 'Equations',
      'reader.references': 'References',
      'reader.noDoc': 'No copied paper yet.',
      'reader.openHtml': 'Open HTML in a new tab',
      'reader.lang.original': 'Original',
      'reader.lang.zh': 'Chinese',
      'reader.lang.bilingual': 'Compare',
      'reader.lang.switch': 'Switch language: Original → Chinese → Compare',
      'reader.ask': 'Ask Big Fatty Fish',
      'reader.askHint': 'Includes title, version, page and surrounding text',
      'reader.askSent': 'Packed for little old me; Your Majesty can read the answer in the conversation.',
      'reader.askFailed': 'Could not send it: ',
      'reader.askNoSession': 'No open conversation yet.',
      'reader.askPlaceholder': 'Write your annotation or question…',
      'reader.notePlaceholder': 'Write something for this annotation',
      'reader.added': 'Added as an annotation; edit the question and send it in the conversation.',
      'reader.return': 'Back to reading',
      'home.surveyTitle': 'Literature review',
      'home.surveyDesc': 'Put two or three papers on one comparison table',
      'home.surveyGo': 'Start comparing →',
      'survey.title': 'Which papers should little old me compare',
      'survey.lead': 'Pick 2–3; little old me only extracts the abstract, sections and key passages, not the whole paper.',
      'survey.pick': 'Click to select',
      'survey.selected': 'Selected ',
      'survey.start': 'Start comparing',
      'survey.limit': 'Three papers at most; deselect one first.',
      'survey.empty': 'No papers in the library yet. Copy one in first.',
      'survey.back': 'Back to home',
      'compare.surveyTitle': 'Literature review',
      'compare.citationTitle': 'Citation check',
      'compare.close': 'Close',
      'compare.loading': 'Little old me is compressing the paper digests…',
      'compare.loadFailed': 'Could not read the digests: ',
      'compare.sections': 'Sections',
      'compare.counts': 'Scale',
      'compare.openReader': 'Open reader',
      'compare.table': 'Comparison table',
      'compare.generate': 'Build table',
      'compare.regenerating': 'Little old me is comparing…',
      'compare.tableEmpty': 'No table yet. Build one to line the papers up across seven fields.',
      'compare.ask': 'Ask together',
      'compare.askPlaceholder': 'What should Big Fatty Fish focus on? (optional)',
      'compare.askSend': 'Send these papers to the conversation',
      'compare.sending': 'Packing the comparison…',
      'compare.sent': 'Sent to the conversation; the comparison message is in the composer.',
      'compare.judge': 'Check support',
      'compare.judging': 'Little old me is checking the citation chain…',
      'compare.citing': 'Citing passage',
      'compare.backCite': 'Back to citation',
      'compare.evidence': 'Evidence',
      'compare.verdict': 'Support',
      'compare.noTable': 'No table',
      'compare.ungrounded': 'Unanchored',
      'compare.papers': 'papers',
      'compare.question': 'Overall question',
      'compare.stats': 'Anchored ',
      'compare.toolHint': 'The conversation calls doraemon_read_papers for the compact digests.',
      'art.mascot.alt':
        'Big Fatty Fish in a blue whale hood with a white cat-face panel, deep-blue hair and cape, standing and waiting for Your Majesty to pick a path',
      'art.mascot.home':
        'Big Fatty Fish holding an open book with both hands and looking directly at Your Majesty',
      'art.mascot.loading': 'Big Fatty Fish standing and turning a page while a task is running',
      'art.mascot.success': 'Big Fatty Fish raising one hand in celebration while still supporting the book',
      'art.mascot.error': 'Big Fatty Fish slumped over the book with crossed eyes, playfully pretending to be defeated',
      'art.mascot.lookup':
        'Big Fatty Fish in a deerstalker and monocle, holding a magnifier and notebook while tracing a paper',
      'art.mascot.stack': 'Big Fatty Fish carefully balancing a stack of thick storybooks',
      'art.mascot.readerError': 'Big Fatty Fish lying on the floor beside an open book when a paper cannot be read',
      'art.doc.alt': 'Pixel icon of a paper PDF',
      'art.query.alt': 'Pixel icon of a magnifier',
    }

    //#endregion

    //#region 组件

    /**
     * 主形象插画（吉祥物）。一屏一个，尺寸按调用处给（§5.1 / §5.5 的 @2x 整数倍）。
     * @param {(key: string) => string} t - 翻译函数。
     * @param {number} size - 逻辑像素边长。
     * @param {{src?: string, altKey?: string}} [options] - 当前状态资产与屏幕阅读器文案。
     * @returns {object} React 元素。
     */
    function mascotArt(t, size, options = {}) {
      return React.createElement('img', {
        className: 'dpr-mascot is-transparent',
        src: options.src || MASCOT_SRC,
        width: size,
        height: size,
        alt: t(options.altKey || 'art.mascot.alt'),
      })
    }

    /**
     * 透明横向精灵图。外层固定尺寸，内层按固定帧宽位移；
     * 动画只改 transform，减少动态时由 CSS 直接显示首帧或完成帧。
     * @param {(key: string) => string} t - 翻译函数。
     * @param {number} size - 逻辑像素边长。
     * @param {'loading'|'success'} kind - 动画类型。
     * @returns {object} React 元素。
     */
    function mascotSprite(t, size, kind) {
      const spec = MASCOT_SPRITES[kind]
      if (!spec) throw new Error('Unknown mascot sprite: ' + kind)
      const frameVars = {}
      for (let index = 1; index < spec.frames; index += 1) {
        frameVars['--dpr-sprite-frame-' + index] = -size * index + 'px'
      }
      return React.createElement(
        'span',
        {
          className: 'dpr-mascotSprite ' + spec.className,
          role: 'img',
          'aria-label': t(spec.altKey),
          style: {
            width: size,
            height: size,
            '--dpr-sprite-size': size + 'px',
            ...frameVars,
          },
        },
        React.createElement('img', {
          className: 'dpr-mascotSpriteImage',
          src: spec.src,
          width: size * spec.frames,
          height: size,
          alt: '',
          'aria-hidden': true,
        }),
      )
    }

    /**
     * 读论文库：主机扫描作业目录，返回已完成的论文与批注数。
     * @returns {{papers: object[], reload: Function}} 论文列表与刷新函数。
     */
    function useLibrary() {
      const { useState, useEffect } = React
      const [papers, setPapers] = useState([])
      const [tick, setTick] = useState(0)
      useEffect(() => {
        let alive = true
        if (typeof window === 'undefined' || !window.location || typeof fetch !== 'function') return undefined
        fetch(apiUrl('library'), { cache: 'no-store' })
          .then(async (response) => {
            const payload = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(payload.error || response.statusText)
            if (alive) setPapers(Array.isArray(payload.papers) ? payload.papers : [])
          })
          .catch(() => {
            if (alive) setPapers([])
          })
        return () => {
          alive = false
        }
      }, [tick])
      return { papers, reload: () => setTick((value) => value + 1) }
    }

    /**
     * 主界面正文：吉祥物 + 居中的问题 + 两条并排入口 + 最近论文。
     * @param {object} props - 槽位组合 props（框架给的 useTabInfo + 注册声明的 t）。
     * @returns {object} React 元素。
     */
    function MaintenanceDialog({ onClose }) {
      const { useState, useEffect } = React
      const [stats, setStats] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const load = async () => {
        setError('')
        try {
          const response = await fetch(apiUrl('maintenance'), { cache: 'no-store' })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(payload.error || '读取维护状态失败')
          setStats(payload)
        } catch (cause) {
          setError(cause?.message || String(cause))
        }
      }
      useEffect(() => {
        void load()
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      const setupPython = async () => {
        setBusy('python')
        setError('')
        try {
          await postApi('maintenance/python', {})
          await load()
        } catch (cause) {
          setError(cause?.message || String(cause))
        } finally {
          setBusy('')
        }
      }
      const cleanup = async () => {
        if (!window.confirm('只清理可重建缓存；论文、批注、术语和归档不会删除。继续吗？')) return
        setBusy('cleanup')
        setError('')
        try {
          const result = await postApi('maintenance/cleanup', {
            scopes: ['comparisons', 'citationAnalyses', 'citationCards', 'vision', 'translation'],
          })
          setStats(result.after)
        } catch (cause) {
          setError(cause?.message || String(cause))
        } finally {
          setBusy('')
        }
      }
      const pythonLabel =
        stats?.python?.status === 'ready'
          ? '受管环境已就绪'
          : stats?.python?.status === 'preparing'
            ? '正在准备'
            : stats?.python?.status === 'failed'
              ? '准备失败'
              : '待检查/安装'
      return React.createElement(
        'div',
        {
          className: 'dpr-maintenanceOverlay',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '运行环境与存储维护',
          onClick: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        React.createElement(
          'section',
          { className: 'dpr-maintenanceCard', onClick: (event) => event.stopPropagation() },
          React.createElement(
            'div',
            { className: 'dpr-maintenanceHead' },
            React.createElement('h3', null, '运行环境与存储'),
            React.createElement('button', { type: 'button', onClick: onClose, 'aria-label': '关闭' }, '×'),
          ),
          error ? React.createElement('div', { className: 'dpr-error', role: 'alert' }, error) : null,
          !stats
            ? React.createElement('p', { className: 'dpr-maintenanceNote' }, '正在统计…')
            : React.createElement(
                React.Fragment,
                null,
                React.createElement(
                  'div',
                  { className: 'dpr-maintenanceGrid' },
                  React.createElement(
                    'div',
                    { className: 'dpr-maintenanceStat' },
                    React.createElement('b', null, '论文与正文'),
                    React.createElement(
                      'span',
                      null,
                      stats.jobs.count + ' 篇 · ' + formatBytes(stats.jobs.bytes),
                    ),
                  ),
                  React.createElement(
                    'div',
                    { className: 'dpr-maintenanceStat' },
                    React.createElement('b', null, '可重建缓存'),
                    React.createElement(
                      'span',
                      null,
                      stats.caches.totalFiles + ' 个文件 · ' + formatBytes(stats.caches.totalBytes),
                    ),
                  ),
                  React.createElement(
                    'div',
                    { className: 'dpr-maintenanceStat' },
                    React.createElement('b', null, '批注批次'),
                    React.createElement(
                      'span',
                      null,
                      stats.protectedData.annotations.files +
                        ' 个文件 · ' +
                        formatBytes(stats.protectedData.annotations.bytes),
                    ),
                  ),
                  React.createElement(
                    'div',
                    { className: 'dpr-maintenanceStat' },
                    React.createElement('b', null, 'Python 运行时'),
                    React.createElement('span', null, pythonLabel),
                  ),
                ),
                stats.python?.executable
                  ? React.createElement(
                      'p',
                      { className: 'dpr-maintenanceNote' },
                      '解释器：' + stats.python.executable,
                    )
                  : null,
                stats.python?.error
                  ? React.createElement('p', { className: 'dpr-error' }, stats.python.error)
                  : null,
                React.createElement(
                  'p',
                  { className: 'dpr-maintenanceNote' },
                  '缓存清理不会删除论文 MirrorDoc、原 PDF、批注、术语表或对照归档；只影响可重新生成的分析与视觉缓存。',
                ),
                React.createElement(
                  'div',
                  { className: 'dpr-maintenanceActions' },
                  React.createElement(
                    'button',
                    { type: 'button', disabled: Boolean(busy), onClick: setupPython },
                    busy === 'python' ? '正在安装 Python 环境…' : '准备/修复 Python 环境',
                  ),
                  React.createElement(
                    'button',
                    { type: 'button', disabled: Boolean(busy), onClick: cleanup },
                    busy === 'cleanup' ? '正在清理…' : '清理可重建缓存',
                  ),
                  React.createElement('button', { type: 'button', disabled: Boolean(busy), onClick: load }, '刷新统计'),
                ),
              ),
        ),
      )
    }

    function HomeBody(props) {
      const actions = props.useTabInfo().tab.actions
      const t = props.t
      const library = useLibrary()
      const [maintenanceOpen, setMaintenanceOpen] = React.useState(false)
      const card = (path) =>
        React.createElement(
          'button',
          {
            key: path.id,
            type: 'button',
            className: 'dpr-card',
            onClick: () => actions.openTab(path.kind),
          },
          React.createElement(
            'span',
            { className: 'dpr-cardTop' },
            art(path.icon, 2, t(path.iconAltKey), 'dpr-cardArt'),
            React.createElement('span', { className: 'dpr-cardIndex', 'aria-hidden': true }, path.id === 'file' ? '01' : '02'),
          ),
          React.createElement('span', { className: 'dpr-cardTitle' }, t(path.titleKey)),
          React.createElement('span', { className: 'dpr-cardDesc' }, t(path.descKey)),
          React.createElement('span', { className: 'dpr-cardGo' }, t('path.open')),
        )
      return React.createElement(
        'div',
        { className: 'dpr-pane dpr-homePane' },
        React.createElement(
          'div',
          { className: 'dpr-col dpr-homeCol' },
          React.createElement(
            'section',
            { className: 'dpr-hero dpr-homeHero' },
            React.createElement(
              'div',
              { className: 'dpr-heroCopy' },
              React.createElement(
                'div',
                { className: 'dpr-eyebrow' },
                React.createElement('span', null, t('home.eyebrow')),
                React.createElement(
                  'span',
                  { className: 'dpr-eyebrowCount' },
                  String(library.papers.length).padStart(2, '0'),
                ),
              ),
              React.createElement('h2', { className: 'dpr-question' }, t('home.question')),
              React.createElement('p', { className: 'dpr-sub' }, t('home.sub')),
              React.createElement(
                'div',
                { className: 'dpr-heroTags', 'aria-label': t('guide.description') },
                React.createElement('span', { className: 'dpr-heroTag is-brand' }, t('home.tagPdf')),
                React.createElement('span', { className: 'dpr-heroTag' }, t('home.tagDoi')),
                React.createElement('span', { className: 'dpr-heroTag' }, t('home.tagArxiv')),
              ),
            ),
            React.createElement(
              'div',
              { className: 'dpr-mascotSticker' },
              mascotArt(t, 168, { src: MASCOT_ASSETS.homeOpenBook, altKey: 'art.mascot.home' }),
              React.createElement('span', null, t('home.mascotCaption')),
            ),
          ),
          React.createElement('div', { className: 'dpr-paths' }, PATHS.map(card)),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dpr-surveyCard',
              onClick: () => actions.openTab(SURVEY_KIND),
            },
            React.createElement(
              'span',
              { className: 'dpr-surveyHead' },
              React.createElement('span', { className: 'dpr-surveyGlyph', 'aria-hidden': true }),
              React.createElement('span', { className: 'dpr-cardTitle' }, t('home.surveyTitle')),
            ),
            React.createElement('span', { className: 'dpr-cardDesc' }, t('home.surveyDesc')),
            React.createElement('span', { className: 'dpr-cardGo' }, t('home.surveyGo')),
          ),
          React.createElement('p', { className: 'dpr-note' }, t('home.note')),
          library.papers.length > 0
            ? React.createElement(
                'section',
                { className: 'dpr-library' },
                React.createElement(
                  'div',
                  { className: 'dpr-libraryHead' },
                  React.createElement('span', { className: 'dpr-libraryTitle' }, t('home.recent')),
                  React.createElement(
                    'span',
                    { className: 'dpr-libraryCount' },
                    library.papers.length + ' ' + t('compare.papers'),
                  ),
                  React.createElement(
                    'button',
                    { type: 'button', className: 'dpr-libraryRefresh', onClick: library.reload },
                    t('home.refresh'),
                  ),
                ),
                React.createElement(
                  'div',
                  { className: 'dpr-libraryList' },
                  library.papers.map((paper) =>
                    React.createElement(
                      'button',
                      {
                        key: paper.jobId,
                        type: 'button',
                        className: 'dpr-libraryItem',
                        onClick: () => actions.openTab(READER_KIND, { params: { jobId: paper.jobId } }),
                      },
                      React.createElement('span', { className: 'dpr-libraryName' }, paper.title),
                      React.createElement(
                        'span',
                        { className: 'dpr-libraryMeta' },
                        [
                          paper.authors,
                          paper.annotationCount ? paper.annotationCount + ' 条批注' : '',
                          paper.copies > 1 ? paper.copies + ' 个副本' : '',
                          paper.doi,
                        ]
                          .filter(Boolean)
                          .join(' · '),
                      ),
                    ),
                  ),
                ),
              )
            : null,
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dpr-maintenanceBtn',
              onClick: () => setMaintenanceOpen(true),
            },
            t('home.maintenance'),
          ),
          maintenanceOpen
            ? React.createElement(MaintenanceDialog, { onClose: () => setMaintenanceOpen(false) })
            : null,
        ),
      )
    }

    /**
     * 路径页正文：空态 + 打算做什么 + 回主界面。
     * @param {object} props - 槽位组合 props（useTabInfo + t + 注册期注入的 path）。
     * @returns {object} React 元素。
     */
    function PathBody(props) {
      const actions = props.useTabInfo().tab.actions
      const t = props.t
      const path = props.path
      return React.createElement(
        'div',
        { className: 'dpr-pane' },
        React.createElement(
          'div',
          { className: 'dpr-col' },
          React.createElement(
            'div',
            { className: 'dpr-hero' },
            mascotArt(t, 120, { src: MASCOT_ASSETS.homeOpenBook, altKey: 'art.mascot.home' }),
            React.createElement('h2', { className: 'dpr-question' }, t(path.headingKey)),
            React.createElement('p', { className: 'dpr-sub' }, t(path.leadKey)),
          ),
          React.createElement(
            'ul',
            { className: 'dpr-todo' },
            path.itemKeys.map((key) =>
              React.createElement(
                'li',
                { key: key, className: 'dpr-todoItem' },
                React.createElement('span', { className: 'dpr-bullet', 'aria-hidden': true }),
                React.createElement('span', null, t(key)),
              ),
            ),
          ),
          React.createElement('p', { className: 'dpr-note' }, t('path.wip')),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dpr-back',
              onClick: () => actions.openTab(HOME_KIND, { replaceTab: true }),
            },
            t('path.back'),
          ),
        ),
      )
    }

    /**
     * 多篇综述的选择页：只负责选 2–3 篇；对照本身在 shell.overlay 的全宽视图里。
     * @param {object} props - 槽位组合 props。
     * @returns {object} React 元素。
     */
    function SurveyBody(props) {
      const { useState } = React
      const actions = props.useTabInfo().tab.actions
      const t = props.t
      const library = useLibrary()
      const [selected, setSelected] = useState([])
      const [notice, setNotice] = useState('')

      const toggle = (jobId) => {
        if (selected.includes(jobId)) {
          setSelected(selected.filter((id) => id !== jobId))
          setNotice('')
          return
        }
        if (selected.length >= 3) {
          setNotice(t('survey.limit'))
          return
        }
        setSelected([...selected, jobId])
        setNotice('')
      }

      const start = () => {
        if (selected.length < 2) {
          setNotice('至少选 2 篇。')
          return
        }
        comparisonStore.open({ mode: 'survey', jobIds: selected })
        setNotice('已打开对照视图。')
      }

      return React.createElement(
        'div',
        { className: 'dpr-pane' },
        React.createElement(
          'div',
          { className: 'dpr-col' },
          React.createElement(
            'div',
            { className: 'dpr-hero' },
            library.papers.length === 0
              ? mascotArt(t, 120, { src: MASCOT_ASSETS.stackBooks, altKey: 'art.mascot.stack' })
              : null,
            React.createElement('h2', { className: 'dpr-question' }, t('survey.title')),
            React.createElement('p', { className: 'dpr-sub' }, t('survey.lead')),
          ),
          library.papers.length === 0
            ? React.createElement('p', { className: 'dpr-note' }, t('survey.empty'))
            : React.createElement(
                'div',
                { className: 'dpr-surveyList' },
                library.papers.map((paper) =>
                  React.createElement(
                    'label',
                    {
                      key: paper.jobId,
                      className: 'dpr-surveyRow' + (selected.includes(paper.jobId) ? ' is-selected' : ''),
                    },
                    React.createElement('input', {
                      type: 'checkbox',
                      checked: selected.includes(paper.jobId),
                      onChange: () => toggle(paper.jobId),
                    }),
                    React.createElement(
                      'span',
                      null,
                      React.createElement('span', { className: 'dpr-surveyName' }, paper.title),
                      React.createElement(
                        'span',
                        { className: 'dpr-surveyMeta' },
                        [
                          paper.authors,
                          paper.doi,
                          paper.annotationCount ? paper.annotationCount + ' 条批注' : '',
                        ]
                          .filter(Boolean)
                          .join(' · '),
                      ),
                    ),
                  ),
                ),
              ),
          React.createElement(
            'p',
            { className: 'dpr-note' },
            t('survey.selected') + selected.length + ' / 3' + (notice ? ' · ' + notice : ''),
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dpr-primary',
              disabled: selected.length < 2,
              onClick: start,
            },
            t('survey.start') + (selected.length ? '（' + selected.length + '）' : ''),
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dpr-back',
              onClick: () => actions.openTab(HOME_KIND, { replaceTab: true }),
            },
            t('survey.back'),
          ),
        ),
      )
    }

    /**
     * 信息查询：多字段可选表单 + 正式版/OA 版选择 + 候选列表 + 元数据卡。
     * 不把“正式版”偷偷替换成预印本：要正式版时只给官方链接。
     */
    function LookupBody(props) {
      const { useState, useEffect } = React
      const tabInfo = props.useTabInfo().tab
      const actions = tabInfo.actions
      const params = tabInfo.navigation?.params || {}
      const incoming = params.fields || {}
      const fromCitation = params.fromCitation || null
      const previewJobId = params.previewJobId || ''
      const previewReady = Boolean(params.previewReady)
      const t = props.t
      const [fields, setFields] = useState({
        query: incoming.query || '',
        title: incoming.title || '',
        authors: incoming.authors || '',
        venue: incoming.venue || '',
        year: incoming.year || '',
        doi: incoming.doi || '',
        arxiv: incoming.arxiv || '',
      })
      const [strictPublished, setStrictPublished] = useState(false)
      const [result, setResult] = useState(null)
      const [job, setJob] = useState(null)
      const [elapsed, setElapsed] = useState(0)
      const [loading, setLoading] = useState(false)
      const [previewOpening, setPreviewOpening] = useState(false)
      const [error, setError] = useState('')
      const incomingKey = JSON.stringify(incoming)

      useEffect(() => {
        if (!fromCitation) return
        setFields({
          query: incoming.query || '',
          title: incoming.title || '',
          authors: incoming.authors || '',
          venue: incoming.venue || '',
          year: incoming.year || '',
          doi: incoming.doi || '',
          arxiv: incoming.arxiv || '',
        })
        setResult(null)
        setJob(null)
        setElapsed(0)
        setError('')
      }, [incomingKey, fromCitation?.jobId, fromCitation?.blockId, fromCitation?.number])

      const patchField = (key, value) => setFields((current) => ({ ...current, [key]: value }))
      const openReader = (jobId) =>
        actions.openTab(READER_KIND, {
          params: fromCitation ? { jobId, fromCitation } : { jobId },
        })
      const postJson = async (relative, body) => {
        const response = await fetch(apiUrl(relative), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(payload.error || response.statusText || '查询失败')
        return payload
      }

      const openPreviewCopy = async () => {
        if (!previewJobId || !previewReady) return
        setPreviewOpening(true)
        setError('')
        try {
          const payload = await postJson('citations/promote', { jobId: previewJobId })
          if (payload.jobId) openReader(payload.jobId)
        } catch (cause) {
          setError(cause?.message || String(cause))
        } finally {
          setPreviewOpening(false)
        }
      }

      const resolve = async () => {
        setLoading(true)
        setError('')
        setResult(null)
        try {
          const payload = await postJson('lookup/resolve', { ...fields, strictPublished })
          if (payload.kind === 'existing') {
            openReader(payload.existingJobId)
            return
          }
          setResult(payload)
        } catch (cause) {
          setError(cause?.message || String(cause))
        } finally {
          setLoading(false)
        }
      }

      const startFetch = async (extra = {}) => {
        setLoading(true)
        setError('')
        try {
          const payload = await postJson('lookup/fetch', { ...fields, ...extra, strictPublished })
          if (payload.kind === 'existing') {
            openReader(payload.existingJobId)
            return
          }
          if (payload.id) {
            setResult(null)
            setJob(payload)
            return
          }
          setResult(payload)
        } catch (cause) {
          setError(cause?.message || String(cause))
        } finally {
          setLoading(false)
        }
      }

      useEffect(() => {
        if (!job || job.status !== 'running') return undefined
        const timer = setInterval(async () => {
          try {
            const response = await fetch(apiUrl('jobs/' + job.id), { cache: 'no-store' })
            const payload = await response.json().catch(() => ({}))
            if (response.ok) setJob(payload)
          } catch {
            // 网络抖动不结束任务；下一次轮询继续。
          }
        }, 1000)
        return () => clearInterval(timer)
      }, [job?.id, job?.status])

      useEffect(() => {
        if (!job || job.status !== 'running') return undefined
        const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - Date.parse(job.startedAt || '')) / 1000)))
        tick()
        const timer = setInterval(tick, 1000)
        return () => clearInterval(timer)
      }, [job?.id, job?.status, job?.startedAt])

      if (job) {
        const failed = job.status === 'failed'
        const panel = React.createElement(LoadingPanel, {
          job,
          t,
          elapsed,
          onOpenReader: () => openReader(job.id),
          onReset: () => {
            setJob(null)
            setElapsed(0)
            setResult(null)
          },
          onBack: () => actions.openTab(HOME_KIND, { replaceTab: true }),
        })
        return React.createElement(
          'div',
          { className: 'dpr-pane' },
          React.createElement(
            'div',
            { className: 'dpr-col' },
            panel,
            failed && job.metadata?.officialUrl
              ? React.createElement(
                  'a',
                  {
                    className: 'dpr-back',
                    href: job.metadata.officialUrl,
                    target: '_blank',
                    rel: 'noreferrer',
                  },
                  '打开官方页面',
                )
              : null,
          ),
        )
      }

      const metadata = result?.metadata
      const metadataAuthors = Array.isArray(metadata?.authors)
        ? metadata.authors.slice(0, 8).join(', ') +
          (metadata.authors.length > 8 ? ' 等 ' + metadata.authors.length + ' 人' : '')
        : metadata?.authors || ''
      const card = metadata
        ? React.createElement(
            'div',
            { className: 'dpr-metaCard' },
            React.createElement('h3', { className: 'dpr-metaTitle' }, metadata.title || '未命名论文'),
            React.createElement(
              'div',
              { className: 'dpr-metaLine' },
              [metadataAuthors, metadata.venue, metadata.year]
                .filter(Boolean)
                .join(' · '),
            ),
            React.createElement(
              'div',
              { className: 'dpr-metaLine' },
              [metadata.doi ? 'DOI ' + metadata.doi : '', metadata.arxiv ? 'arXiv ' + metadata.arxiv : '', result?.version?.label]
                .filter(Boolean)
                .join(' · '),
            ),
            metadata.abstract
              ? React.createElement('p', { className: 'dpr-metaAbstract' }, String(metadata.abstract).slice(0, 420))
              : null,
            React.createElement(
              'div',
              { className: 'dpr-metaLine' },
              result?.kind === 'metadata-only'
                ? result.message || '只找到元数据，没有找到可合法取回的全文。'
                : '来源：' + (result?.route || '待选'),
            ),
            result?.kind === 'exact'
              ? React.createElement(
                  'button',
                  { type: 'button', className: 'dpr-primary', disabled: loading, onClick: () => startFetch() },
                  loading ? '小的我去取…' : '取回并阅读',
                )
              : null,
            result?.existingJobId
              ? React.createElement(
                  'button',
                  { type: 'button', className: 'dpr-back', onClick: () => openReader(result.existingJobId) },
                  '打开已有本地副本',
                )
              : null,
            metadata.officialUrl
              ? React.createElement(
                  'a',
                  { className: 'dpr-back', href: metadata.officialUrl, target: '_blank', rel: 'noreferrer' },
                  '打开官方页面',
                )
              : null,
          )
        : null

      return React.createElement(
        'div',
        { className: 'dpr-pane' },
        React.createElement(
          'div',
          { className: 'dpr-col' },
          fromCitation
            ? React.createElement(
                'div',
                { className: 'dpr-citeFrom' },
                React.createElement(
                  'span',
                  null,
                  '来自《' + (fromCitation.title || '当前论文') + '》的引用 [' + (fromCitation.number || '?') + ']',
                ),
                fromCitation.jobId
                  ? React.createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'dpr-back',
                        onClick: () =>
                          actions.openTab(READER_KIND, {
                            params: { jobId: fromCitation.jobId, blockId: fromCitation.blockId || '' },
                          }),
                      },
                      '返回引用处',
                    )
                  : null,
              )
            : null,
          previewJobId
            ? React.createElement(
                'div',
                { className: 'dpr-citeFrom' },
                React.createElement(
                  'span',
                  null,
                  previewReady ? '这篇论文的预览副本已经就绪，可直接阅读。' : '预览副本正在取回，完成后可在这里打开。',
                ),
                previewReady
                  ? React.createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'dpr-back',
                        disabled: previewOpening,
                        onClick: openPreviewCopy,
                      },
                      previewOpening ? '正在打开…' : '打开预览副本',
                    )
                  : null,
              )
            : null,
          React.createElement(
            'div',
            { className: 'dpr-hero' },
            loading
              ? mascotSprite(t, 120, 'loading')
              : error || result?.kind === 'none'
                ? mascotArt(t, 120, { src: MASCOT_ASSETS.errorPlayDead, altKey: 'art.mascot.error' })
                : result
                  ? mascotSprite(t, 120, 'success')
                  : mascotArt(t, 120, {
                      src: MASCOT_ASSETS.lookupDetective,
                      altKey: 'art.mascot.lookup',
                    }),
            React.createElement('h2', { className: 'dpr-question' }, '陛下给个线索，小的我去找论文'),
            React.createElement('p', { className: 'dpr-sub' }, '哪个字段知道就填哪个，不必填满；填得越多越准。'),
          ),
          React.createElement(
            'div',
            { className: 'dpr-lookup' },
            React.createElement(
              'div',
              { className: 'dpr-lookupMode' },
              React.createElement(
                'button',
                { type: 'button', className: !strictPublished ? 'is-active' : '', onClick: () => setStrictPublished(false) },
                '可用预印本 / OA 版',
              ),
              React.createElement(
                'button',
                { type: 'button', className: strictPublished ? 'is-active' : '', onClick: () => setStrictPublished(true) },
                '严格要正式版（只给官网链接）',
              ),
            ),
            React.createElement(
              'div',
              { className: 'dpr-lookupField', style: { gridColumn: '1 / -1' } },
              React.createElement('span', null, '标题'),
              React.createElement('input', {
                value: fields.title,
                placeholder: '论文标题（可只填关键词）',
                onChange: (event) => patchField('title', event.target.value),
              }),
            ),
            React.createElement(
              'div',
              { className: 'dpr-lookupGrid' },
              React.createElement(
                'label',
                { className: 'dpr-lookupField' },
                React.createElement('span', null, 'DOI'),
                React.createElement('input', {
                  value: fields.doi,
                  placeholder: '10.3390/s22114003',
                  onChange: (event) => patchField('doi', event.target.value),
                }),
              ),
              React.createElement(
                'label',
                { className: 'dpr-lookupField' },
                React.createElement('span', null, 'arXiv'),
                React.createElement('input', {
                  value: fields.arxiv,
                  placeholder: '2501.12948',
                  onChange: (event) => patchField('arxiv', event.target.value),
                }),
              ),
              React.createElement(
                'label',
                { className: 'dpr-lookupField' },
                React.createElement('span', null, '作者'),
                React.createElement('input', {
                  value: fields.authors,
                  placeholder: '作者 / 团队',
                  onChange: (event) => patchField('authors', event.target.value),
                }),
              ),
              React.createElement(
                'label',
                { className: 'dpr-lookupField' },
                React.createElement('span', null, '刊物 / 会议'),
                React.createElement('input', {
                  value: fields.venue,
                  placeholder: 'Sensors / NeurIPS / …',
                  onChange: (event) => patchField('venue', event.target.value),
                }),
              ),
              React.createElement(
                'label',
                { className: 'dpr-lookupField' },
                React.createElement('span', null, '年份'),
                React.createElement('input', {
                  value: fields.year,
                  inputMode: 'numeric',
                  placeholder: '2022',
                  onChange: (event) => patchField('year', event.target.value),
                }),
              ),
              React.createElement(
                'label',
                { className: 'dpr-lookupField' },
                React.createElement('span', null, '自由关键词'),
                React.createElement('input', {
                  value: fields.query,
                  placeholder: '标题记不全时写几个词',
                  onChange: (event) => patchField('query', event.target.value),
                }),
              ),
            ),
            React.createElement(
              'button',
              { type: 'button', className: 'dpr-primary', disabled: loading, onClick: resolve },
              loading ? '小的我去认论文…' : '去找论文',
            ),
            React.createElement(
              'p',
              { className: 'dpr-lookupHint' },
              strictPublished
                ? '严格正式版：小的我只查元数据并给官网链接，不擅自用预印本替代。'
                : '可用预印本/OA：先 arXiv HTML，再 arXiv PDF，再合法 OA PDF；付费墙不碰。',
            ),
            error ? React.createElement('div', { className: 'dpr-error', role: 'alert' }, error) : null,
          ),
          card,
          result?.kind === 'candidates'
            ? React.createElement(
                'div',
                { className: 'dpr-annotationList' },
                result.candidates.map((candidate) =>
                  React.createElement(
                    'button',
                    {
                      key: candidate.doi || candidate.arxiv || candidate.title,
                      type: 'button',
                      className: 'dpr-candidate',
                      onClick: () =>
                        candidate.existingJobId
                          ? openReader(candidate.existingJobId)
                          : startFetch({
                              doi: candidate.doi || '',
                              arxiv: candidate.arxiv || '',
                              title: candidate.title || '',
                              query: '',
                            }),
                    },
                    React.createElement('span', { className: 'dpr-candidateTitle' }, candidate.title),
                    React.createElement(
                      'span',
                      { className: 'dpr-candidateMeta' },
                      [candidate.authors?.[0], candidate.venue, candidate.year, candidate.isOa ? 'OA' : '非 OA']
                        .filter(Boolean)
                        .join(' · '),
                    ),
                  ),
                ),
              )
            : null,
          result?.kind === 'none'
            ? React.createElement('p', { className: 'dpr-note' }, result.message || '没有找到这篇论文。')
            : null,
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dpr-back',
              onClick: () => actions.openTab(HOME_KIND, { replaceTab: true }),
            },
            t('path.back'),
          ),
        ),
      )
    }

    //#region PDF 导入 / 后台抄写 / 阅读页

    const MAX_UPLOAD_BYTES = 200 * 1024 * 1024
    const STAGE_ORDER = ['queued', 'read', 'classify', 'assets', 'crop', 'pages', 'mirror', 'verify', 'render', 'done']
    const HTML_STAGE_ORDER = ['queued', 'fetch', 'extract', 'render', 'done']
    const stageOrderFor = (job) => (job?.pipeline === 'html' ? HTML_STAGE_ORDER : STAGE_ORDER)

    function isPdfFile(file) {
      return Boolean(file) && (file.type === 'application/pdf' || /\.pdf$/i.test(String(file.name ?? '')))
    }

    function formatBytes(bytes) {
      const value = Number(bytes) || 0
      if (value < 1024) return value + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
      return (value / (1024 * 1024)).toFixed(1) + ' MB'
    }

    function formatDuration(seconds) {
      const total = Math.max(0, Math.floor(Number(seconds) || 0))
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const rest = total % 60
      const mm = String(minutes).padStart(2, '0')
      const ss = String(rest).padStart(2, '0')
      return hours > 0 ? hours + ':' + mm + ':' + ss : mm + ':' + ss
    }

    function apiUrl(relative) {
      return 'doraemon-paper-reader/api/' + String(relative).replace(/^\/+/, '')
    }

    /** 小 JSON POST 的统一入口；错误文本直接来自宿主。 */
    async function postApi(relative, body) {
      const response = await fetch(apiUrl(relative), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(payload.error || response.statusText || '请求失败')
      return payload
    }

    function assetUrl(jobId, asset) {
      const name = String(asset ?? '').split('/').pop()
      return apiUrl('jobs/' + jobId + '/assets/' + name)
    }

    function sourcePageUrl(jobId, page) {
      return apiUrl('jobs/' + jobId + '/source-pages/page-' + String(page).padStart(2, '0') + '.png')
    }

    function stageState(job, stage) {
      if (!job) return 'pending'
      if (job.status === 'done') return 'done'
      const order = stageOrderFor(job)
      if (job.status === 'failed') {
        const current = order.indexOf(job.stage)
        const index = order.indexOf(stage)
        if (current < 0) return stage === 'failed' ? 'failed' : 'pending'
        return index < current ? 'done' : index === current ? 'failed' : 'pending'
      }
      const current = order.indexOf(job.stage)
      const index = order.indexOf(stage)
      if (current < 0) return stage === 'queued' ? 'active' : 'pending'
      return index < current ? 'done' : index === current ? 'active' : 'pending'
    }

    /**
     * 组装给模型的论文上下文包：版本、标识符、页码、原文、前后文、邻近图表公式、
     * 以及转换时已生成的 paper brief。字段短而明确，优先给模型读，不是给人读。
     * @param {object} doc - MirrorDoc。
     * @param {object} selection - 选区（quote/before/after/page/blockId/section）。
     * @param {string} jobId - 任务 id。
     * @returns {object} 上下文包。
     */
    function buildContextPacket(doc, selection, jobId) {
      const meta = doc?.meta ?? {}
      const version = doc?.version ?? {}
      const brief = meta.brief ?? {}
      const page = Number(selection?.page) || 0
      const nearby = (doc?.blocks ?? [])
        .filter((block) => block.page === page && ['figure', 'table', 'equation'].includes(block.type))
        .slice(0, 4)
        .map((block) => ({
          kind: block.type,
          label: block.label || '',
          caption: String(block.caption || block.text || '').slice(0, 320),
        }))
      const citationPath =
        'work/doraemon-paper-cites/' + jobId + '/' + (selection?.blockId || '') + '.dprcite'
      const citationDeepLink =
        'dsh-resource://doraemon-paper/' + jobId + '/' + (selection?.blockId || '')
      return {
        paper: {
          title: meta.title || '',
          doi: meta.doi || '',
          arxiv: meta.arxivId || '',
        },
        version: {
          kind: version.kind || 'unknown',
          label: version.label || '版本未核验',
          source: version.source || '',
          license: version.license || '',
          sha256: String(version.sha256 || '').slice(0, 16),
        },
        locator: {
          page,
          blockId: selection?.blockId || '',
          section: selection?.section || '',
        },
        selection: {
          quote: String(selection?.quote || '').slice(0, 2400),
          before: String(selection?.before || '').slice(0, 320),
          after: String(selection?.after || '').slice(0, 320),
        },
        nearbyAssets: nearby,
        brief: {
          abstract: String(brief.abstract || meta.abstract || '').slice(0, 1200),
          sections: (brief.sections ?? []).slice(0, 8),
          figures: (brief.figures ?? []).slice(0, 8),
          tables: (brief.tables ?? []).slice(0, 6),
          equations: (brief.equations ?? []).slice(0, 6),
          referenceCount: brief.referenceCount ?? 0,
        },
        citationPath,
        citationDeepLink,
        citation: '[p.' + page + '](' + citationDeepLink + ')',
      }
    }

    /**
     * @param {string} address - `dsh-resource://doraemon-paper/<jobId>/<blockId>`。
     * @returns {{jobId: string, blockId: string} | null} 解析结果。
     */
    function parseReaderAddress(address) {
      const value = String(address || '')
      const workspaceMatch =
        /\/work\/doraemon-paper-cites\/([^/?#]+)\/([^/?#]+?)(?:\.dprcite)?(?:[?#].*)?$/i.exec(value)
      if (workspaceMatch) return { jobId: workspaceMatch[1], blockId: workspaceMatch[2] }
      const fileMatch =
        /^dsh-resource:\/\/file\/session\/[^/]+\/doraemon-paper\/([^/?#]+)\/([^/?#]+?)(?:\.dprcite)?(?:[?#].*)?$/i.exec(
          value,
        )
      if (fileMatch) return { jobId: fileMatch[1], blockId: fileMatch[2] }
      const match = /^dsh-resource:\/\/doraemon-paper\/([^/?#]+)\/([^/?#]+)/i.exec(value)
      return match ? { jobId: match[1], blockId: match[2] } : null
    }

    /**
     * 把一个正文块按引用 spans 切成 text / citation 片段。
     * spans 由宿主 /citations 索引提供，前端不重复跑引用正则。
     */
    function splitCitationText(text, spans) {
      const source = String(text ?? '')
      const ordered = [...(spans || [])]
        .filter((span) => Number.isInteger(span?.start) && Number.isInteger(span?.end))
        .sort((a, b) => a.start - b.start)
      const parts = []
      let cursor = 0
      for (const span of ordered) {
        if (span.start < cursor || span.start < 0 || span.end > source.length) continue
        if (span.start > cursor) parts.push({ type: 'text', text: source.slice(cursor, span.start) })
        parts.push({ type: 'citation', span, text: source.slice(span.start, span.end) })
        cursor = span.end
      }
      if (cursor < source.length) parts.push({ type: 'text', text: source.slice(cursor) })
      return parts
    }

    function citationStanceLabel(stance) {
      return (
        {
          supports: '支持引用处主张',
          contrasts: '与引用处形成对照',
          method: '方法/工具被借用',
          background: '背景铺垫',
          mixed: '关系兼有',
          unclear: '关系不明确',
        }[stance] || '关系不明确'
      )
    }

    /** 引用卡片 → 查询页的预填参数。 */
    function citationLookupParams(state) {
      const meta = state?.analysis?.metadata || state?.metadata || {}
      const reference = state?.reference || state?.resolved?.reference || {}
      const authors = Array.isArray(meta.authors) ? meta.authors.join(', ') : meta.authors || reference.authors || ''
      return {
        fromCitation: {
          jobId: state?.citing?.jobId || '',
          blockId: state?.citing?.blockId || '',
          number: state?.number || 0,
          title: state?.citing?.paperTitle || '',
        },
        previewJobId: state?.resolved?.kind === 'running' ? state.jobId || '' : '',
        previewReady: Boolean(state?.resolved?.kind === 'running' && state?.job?.status === 'done'),
        fields: {
          title: meta.title || reference.title || '',
          authors,
          venue: meta.venue || '',
          year: String(meta.year || reference.year || ''),
          doi: meta.doi || reference.doi || '',
          arxiv: meta.arxiv || reference.arxiv || '',
          query: meta.title || reference.title ? '' : reference.raw || '',
        },
      }
    }

    /** 引用预览：左侧目录 + 右侧可滚动内容。 */
    function CitationPreview(props) {
      const { useState, useEffect, useRef } = React
      const { state, onClose, onChoose, onChooseCandidate, onRetry, onOpenLookup } = props
      const contentRef = useRef(null)
      const [active, setActive] = useState('overview')
      const meta = state?.analysis?.metadata || state?.metadata || {}
      const analysis = state?.analysis
      const title = meta.title || state?.reference?.title || '引用论文'
      const authors = Array.isArray(meta.authors) ? meta.authors.slice(0, 6).join(', ') : meta.authors || ''
      const metaLine = [authors, meta.venue, meta.year].filter(Boolean).join(' · ')
      const basis = analysis?.basis || state?.basis || ''
      const versionLabel =
        state?.version?.label ||
        state?.resolved?.version?.label ||
        (state?.job?.status === 'running' ? '正在取回' : '版本未核对')
      const navItems = [
        { id: 'overview', label: '文章概览' },
        { id: 'relation', label: '引用关系' },
        { id: 'basis', label: '依据与来源' },
      ]

      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])

      const jump = (id) => {
        setActive(id)
        const target = contentRef.current?.querySelector('[data-cite-section="' + id + '"]')
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }

      const onScroll = () => {
        const content = contentRef.current
        if (!content) return
        const top = content.getBoundingClientRect().top + 24
        let current = 'overview'
        for (const section of content.querySelectorAll('[data-cite-section]')) {
          if (section.getBoundingClientRect().top <= top) current = section.dataset.citeSection
        }
        setActive(current)
      }

      const stageIndex =
        state?.stage === 'resolving' ? 0 : state?.stage === 'fetching' ? 1 : state?.stage === 'analyzing' ? 2 : 3
      const stages = [
        '解析引用与参考文献',
        '查找合法全文/预印本',
        '生成文章概览',
        '对照引用处生成关系',
      ]

      const body =
        state?.stage === 'choose'
          ? React.createElement(
              React.Fragment,
              null,
              React.createElement('p', { className: 'dpr-citeMetaLine' }, '这条引用包含多篇论文，先选一篇：'),
              React.createElement(
                'div',
                { className: 'dpr-citeChoices' },
                state.numbers.map((number) =>
                  React.createElement(
                    'button',
                    { key: number, type: 'button', onClick: () => onChoose(number) },
                    '[' + number + ']',
                  ),
                ),
              ),
            )
          : state?.stage === 'candidates'
            ? React.createElement(
                'div',
                { className: 'dpr-annotationList' },
                React.createElement('p', { className: 'dpr-citeMetaLine' }, '找到多篇候选，选一篇继续：'),
                (state.candidates || []).map((candidate) =>
                  React.createElement(
                    'button',
                    {
                      key: candidate.doi || candidate.arxiv || candidate.title,
                      type: 'button',
                      className: 'dpr-candidate',
                      onClick: () => onChooseCandidate(candidate),
                    },
                    React.createElement('span', { className: 'dpr-candidateTitle' }, candidate.title || '未命名论文'),
                    React.createElement(
                      'span',
                      { className: 'dpr-candidateMeta' },
                      [candidate.authors?.[0], candidate.venue, candidate.year, candidate.isOa ? 'OA' : '非 OA']
                        .filter(Boolean)
                        .join(' · '),
                    ),
                  ),
                ),
              )
            : state?.stage === 'error'
              ? React.createElement(
                  React.Fragment,
                  null,
                  React.createElement('div', { className: 'dpr-error', role: 'alert' }, state.error || '引用预览失败'),
                  React.createElement('p', { className: 'dpr-citeMetaLine' }, state.metadata?.abstract || ''),
                )
              : state?.stage === 'metadata'
                ? React.createElement(
                    React.Fragment,
                    null,
                    React.createElement(
                      'p',
                      { className: 'dpr-citeWarn' },
                      state.error || '只找到摘要/元数据，暂时无法生成全文概览；可以点“精读这篇”进入查询流程。',
                    ),
                    state.metadata?.abstract
                      ? React.createElement(
                          'p',
                          { className: 'dpr-citeMetaLine' },
                          String(state.metadata.abstract).slice(0, 600),
                        )
                      : null,
                  )
              : state?.stage !== 'ready' || !analysis
                ? React.createElement(
                    React.Fragment,
                    null,
                    React.createElement(
                      'ul',
                      { className: 'dpr-citeStages' },
                      stages.map((label, index) =>
                        React.createElement(
                          'li',
                          {
                            key: label,
                            className:
                              'dpr-citeStage ' +
                              (index < stageIndex ? 'is-done' : index === stageIndex ? 'is-active' : ''),
                          },
                          React.createElement('span', { className: 'dpr-citeStageDot', 'aria-hidden': true }),
                          React.createElement('span', null, label),
                        ),
                      ),
                    ),
                    state?.job?.message
                      ? React.createElement('p', { className: 'dpr-citeMetaLine' }, state.job.message)
                      : null,
                    state?.metadata?.abstract
                      ? React.createElement('p', { className: 'dpr-citeMetaLine' }, String(state.metadata.abstract).slice(0, 360))
                      : null,
                  )
                : React.createElement(
                    React.Fragment,
                    null,
                    React.createElement(
                      'section',
                      { className: 'dpr-citeSection', 'data-cite-section': 'overview' },
                      React.createElement('h4', null, '文章概览'),
                      [
                        ['研究背景', analysis.overview?.background],
                        ['研究问题', analysis.overview?.question],
                        ['方法/数据', analysis.overview?.method],
                        ['主要结论', analysis.overview?.findings],
                        ['关键证据', analysis.overview?.evidence],
                        ['局限/争议', analysis.overview?.limitations],
                      ].map(([label, value]) =>
                        React.createElement(
                          'p',
                          { key: label, className: 'dpr-citeField' },
                          React.createElement('b', null, label),
                          React.createElement('span', null, value || '材料没有给出足够信息。'),
                        ),
                      ),
                    ),
                    React.createElement(
                      'section',
                      { className: 'dpr-citeSection', 'data-cite-section': 'relation' },
                      React.createElement('h4', null, '与引用处的关系'),
                      React.createElement(
                        'span',
                        { className: 'dpr-citeStance' },
                        citationStanceLabel(analysis.relation?.stance),
                      ),
                      analysis.relation?.summary
                        ? React.createElement('p', { className: 'dpr-citeSummary' }, analysis.relation.summary)
                        : null,
                      (analysis.relation?.points || []).length > 0
                        ? analysis.relation.points.map((point, index) =>
                            React.createElement(
                              'div',
                              { key: index, className: 'dpr-citePoint' },
                              React.createElement('p', null, point.claim || '关系要点'),
                              React.createElement(
                                'div',
                                { className: 'dpr-citeEvidence' },
                                point.citingEvidence
                                  ? React.createElement('span', null, '引用处：' + point.citingEvidence)
                                  : null,
                                point.citedEvidence
                                  ? React.createElement('span', null, '被引论文：' + point.citedEvidence)
                                  : null,
                              ),
                            ),
                          )
                        : React.createElement('p', { className: 'dpr-citeMetaLine' }, '材料不足，未能给出可靠的关系要点。'),
                    ),
                    React.createElement(
                      'section',
                      { className: 'dpr-citeSection', 'data-cite-section': 'basis' },
                      React.createElement('h4', null, '依据与来源'),
                      React.createElement(
                        'p',
                        { className: 'dpr-citeField' },
                        React.createElement('b', null, '依据'),
                        React.createElement(
                          'span',
                          null,
                          basis === 'full-text'
                            ? '基于已取回的全文（含章节/段落），未改写原文。'
                            : basis === 'abstract'
                              ? '只找到摘要/元数据，未核对全文。'
                              : '只有元数据，概览可能不完整。',
                        ),
                      ),
                      (analysis.warnings || []).map((warning, index) =>
                        React.createElement('p', { key: index, className: 'dpr-citeWarn' }, warning),
                      ),
                      React.createElement(
                        'p',
                        { className: 'dpr-citeEvidence' },
                        React.createElement('span', null, '参考文献原文：' + (state.reference?.raw || '')),
                      ),
                      meta.doi
                        ? React.createElement(
                            'a',
                            {
                              className: 'dpr-back',
                              href: 'https://doi.org/' + meta.doi,
                              target: '_blank',
                              rel: 'noreferrer',
                            },
                            '打开 DOI 官方页面',
                          )
                        : null,
                    ),
                  )

      return React.createElement(
        'div',
        {
          className: 'dpr-citeOverlay',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '引用预览',
          onClick: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        React.createElement(
          'div',
          { className: 'dpr-citeCard', onClick: (event) => event.stopPropagation() },
          React.createElement(
            'div',
            { className: 'dpr-citeHead' },
            React.createElement(
              'div',
              { className: 'dpr-citeHeadMain' },
              React.createElement(
                'div',
                { className: 'dpr-citeKicker' },
                '引用 [' + (state?.number || '?') + '] · ' + (state?.citing?.paperTitle || '当前论文'),
              ),
              React.createElement('div', { className: 'dpr-citeTitle', title: title }, title),
              metaLine ? React.createElement('div', { className: 'dpr-citeMetaLine' }, metaLine) : null,
              React.createElement(
                'div',
                { className: 'dpr-citeBadges' },
                React.createElement('span', { className: 'dpr-citeBadge' }, versionLabel),
                basis
                  ? React.createElement(
                      'span',
                      { className: 'dpr-citeBadge ' + (basis === 'full-text' ? '' : 'is-warn') },
                      basis === 'full-text' ? '全文依据' : '摘要依据',
                    )
                  : null,
                state?.cached || analysis?.cached
                  ? React.createElement('span', { className: 'dpr-citeBadge' }, '已保存')
                  : null,
                meta.doi ? React.createElement('span', { className: 'dpr-citeBadge' }, 'DOI ' + meta.doi) : null,
              ),
            ),
            React.createElement('button', { type: 'button', className: 'dpr-citeClose', onClick: onClose, 'aria-label': '关闭' }, '×'),
          ),
          React.createElement(
            'div',
            { className: 'dpr-citeBody' },
            React.createElement(
              'nav',
              { className: 'dpr-citeNav', 'aria-label': '引用预览目录' },
              navItems.map((item) =>
                React.createElement(
                  'button',
                  {
                    key: item.id,
                    type: 'button',
                    className: active === item.id ? 'is-active' : '',
                    onClick: () => jump(item.id),
                  },
                  item.label,
                ),
              ),
            ),
            React.createElement(
              'div',
              { className: 'dpr-citeContent', ref: contentRef, onScroll },
              body,
            ),
          ),
          React.createElement(
            'div',
            { className: 'dpr-citeActions' },
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dpr-primary',
                disabled: !state || !['ready', 'metadata', 'error'].includes(state.stage),
                onClick: () => onOpenLookup(state),
              },
              '精读这篇',
            ),
            state?.stage === 'error'
              ? React.createElement('button', { type: 'button', className: 'dpr-back', onClick: onRetry }, '重试')
              : null,
            meta.officialUrl
              ? React.createElement(
                  'a',
                  { className: 'dpr-back', href: meta.officialUrl, target: '_blank', rel: 'noreferrer' },
                  '官方页面',
                )
              : null,
          ),
        ),
      )
    }

    function ReviewDialog(props) {
      const { issues, onLocate, onRerun, onClose } = props
      return React.createElement(
        'div',
        {
          className: 'dpr-citeOverlay',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '译文复核问题',
          onClick: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        React.createElement(
          'div',
          { className: 'dpr-citeCard', onClick: (event) => event.stopPropagation() },
          React.createElement(
            'div',
            { className: 'dpr-citeHead' },
            React.createElement(
              'div',
              { className: 'dpr-citeHeadMain' },
              React.createElement('div', { className: 'dpr-citeKicker' }, '整篇译文复核'),
              React.createElement('div', { className: 'dpr-citeTitle' }, '问题 ' + issues.length + ' 条，自动处理记录'),
              React.createElement(
                'div',
                { className: 'dpr-citeMetaLine' },
                '算法已自动应用通过引用/数字校验的修订；未自动修复的条目保留现译，可在这里追溯或覆盖。点问题标题可跳到原段。',
              ),
            ),
            React.createElement('button', { type: 'button', className: 'dpr-citeClose', onClick: onClose, 'aria-label': '关闭' }, '×'),
          ),
          React.createElement(
            'div',
            { className: 'dpr-reviewBody' },
            issues.length === 0
              ? React.createElement('div', { className: 'dpr-glossaryEmpty' }, '没有发现需要处理的语义问题。')
              : issues.map((issue, index) =>
                  React.createElement(
                    'div',
                    {
                      key: issue.taskId + ':' + index,
                      className:
                        'dpr-reviewIssue ' + (issue.severity === 'error' ? 'is-error' : 'is-warning'),
                    },
                    React.createElement(
                      'div',
                      { className: 'dpr-reviewHead', onClick: () => onLocate(issue.taskId) },
                      React.createElement(
                        'span',
                        { className: 'dpr-reviewSeverity' },
                        issue.severity === 'error' ? '错误' : '提醒',
                      ),
                      React.createElement('strong', null, issue.category || 'semantic'),
                      React.createElement('span', { className: 'dpr-reviewTask' }, issue.taskId),
                    ),
                    React.createElement('div', { className: 'dpr-reviewText' }, issue.detail || ''),
                    issue.source
                      ? React.createElement(
                          'div',
                          { className: 'dpr-reviewText' },
                          React.createElement('span', { className: 'dpr-reviewLabel' }, '原文'),
                          issue.source,
                        )
                      : null,
                    issue.target
                      ? React.createElement(
                          'div',
                          { className: 'dpr-reviewText' },
                          React.createElement('span', { className: 'dpr-reviewLabel' }, '现译'),
                          issue.target,
                        )
                      : null,
                    issue.backTranslation
                      ? React.createElement(
                          'div',
                          { className: 'dpr-reviewText' },
                          React.createElement('span', { className: 'dpr-reviewLabel' }, '回译'),
                          issue.backTranslation,
                        )
                      : null,
                    issue.revisedTarget
                      ? React.createElement(
                          'div',
                          { className: 'dpr-reviewText' },
                          React.createElement('span', { className: 'dpr-reviewLabel' }, '建议'),
                          issue.revisedTarget,
                        )
                      : null,
                    React.createElement(
                      'div',
                      { className: 'dpr-reviewActions' },
                      React.createElement(
                        'span',
                        { className: 'dpr-reviewDecision' },
                        issue.decision === 'accepted'
                          ? issue.automatic
                            ? '算法已自动修订'
                            : '已采用修订'
                          : '算法无法安全修订，已保留现译；可重新复核',
                      ),
                    ),
                  ),
                ),
          ),
          React.createElement(
            'div',
            { className: 'dpr-glossaryActions' },
            React.createElement(
              'button',
              { type: 'button', className: 'dpr-back', onClick: onRerun },
              '重新复核',
            ),
            React.createElement('button', { type: 'button', className: 'dpr-primary', onClick: onClose }, '关闭'),
          ),
        ),
      )
    }

    function GlossaryDialog(props) {
      const { useState, useEffect } = React
      const { entries, onSave, onClose, saving, error } = props
      const [rows, setRows] = useState(() => entries || [])
      useEffect(() => {
        setRows(entries || [])
      }, [entries])
      const patch = (id, key, value) =>
        setRows((current) => current.map((row) => (row.id === id ? { ...row, [key]: value } : row)))
      const remove = (id) => setRows((current) => current.filter((row) => row.id !== id))
      const add = () =>
        setRows((current) => [
          ...current,
          { id: 'new-' + Date.now(), source: '', target: '', locked: false, kind: 'term' },
        ])
      return React.createElement(
        'div',
        {
          className: 'dpr-citeOverlay',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '术语表',
          onClick: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        React.createElement(
          'div',
          { className: 'dpr-citeCard', onClick: (event) => event.stopPropagation() },
          React.createElement(
            'div',
            { className: 'dpr-citeHead' },
            React.createElement(
              'div',
              { className: 'dpr-citeHeadMain' },
              React.createElement('div', { className: 'dpr-citeKicker' }, '翻译术语表'),
              React.createElement('div', { className: 'dpr-citeTitle' }, '统一译名，改完可重译'),
              React.createElement(
                'div',
                { className: 'dpr-citeMetaLine' },
                '自动候选只是建议；目标译文留空的术语不会强塞进提示词。锁定表示保留原文（专名/缩写）。',
              ),
            ),
            React.createElement('button', { type: 'button', className: 'dpr-citeClose', onClick: onClose, 'aria-label': '关闭' }, '×'),
          ),
          React.createElement(
            'div',
            { className: 'dpr-glossaryBody' },
            error ? React.createElement('div', { className: 'dpr-error', role: 'alert' }, error) : null,
            rows.length === 0
              ? React.createElement('div', { className: 'dpr-glossaryEmpty' }, '还没有术语候选，可以手动添加。')
              : null,
            rows.map((row) =>
              React.createElement(
                'div',
                { className: 'dpr-glossaryRow', key: row.id },
                React.createElement('input', {
                  type: 'text',
                  value: row.source || '',
                  placeholder: '原文术语',
                  onChange: (event) => patch(row.id, 'source', event.target.value),
                }),
                React.createElement('input', {
                  type: 'text',
                  value: row.target || '',
                  placeholder: '中文译名（可留空）',
                  onChange: (event) => patch(row.id, 'target', event.target.value),
                }),
                React.createElement(
                  'label',
                  { className: 'dpr-glossaryLock' },
                  React.createElement('input', {
                    type: 'checkbox',
                    checked: Boolean(row.locked),
                    onChange: (event) => patch(row.id, 'locked', event.target.checked),
                  }),
                  '保留',
                ),
                React.createElement(
                  'button',
                  { type: 'button', className: 'dpr-glossaryDelete', onClick: () => remove(row.id) },
                  '删除',
                ),
              ),
            ),
          ),
          React.createElement(
            'div',
            { className: 'dpr-glossaryActions' },
            React.createElement('button', { type: 'button', className: 'dpr-back', onClick: add }, '添加术语'),
            React.createElement(
              'button',
              { type: 'button', className: 'dpr-primary', disabled: saving, onClick: () => onSave(rows) },
              saving ? '保存中…' : '保存并重译',
            ),
          ),
        ),
      )
    }

    function LoadingPanel(props) {
      const { job, t, elapsed, onOpenReader, onReset, onBack } = props
      const done = job.status === 'done'
      const failed = job.status === 'failed'
      const running = job.status === 'running'
      const mascot = failed
        ? mascotArt(t, 216, { src: MASCOT_ASSETS.errorPlayDead, altKey: 'art.mascot.error' })
        : done
          ? mascotSprite(t, 216, 'success')
          : running
            ? mascotSprite(t, 216, 'loading')
            : mascotArt(t, 216, {
                src: MASCOT_ASSETS.loadingTurnPage,
                altKey: 'art.mascot.loading',
              })
      const stages = stageOrderFor(job).map((stage) => {
        const state = stageState(job, stage)
        return React.createElement(
          'li',
          { key: stage, className: 'dpr-stage is-' + state },
          React.createElement('span', { className: 'dpr-stageDot', 'aria-hidden': true }),
          React.createElement('span', null, t('import.stage.' + stage)),
        )
      })
      return React.createElement(
        'div',
        { className: 'dpr-pane' },
        React.createElement(
          'div',
          { className: 'dpr-load' },
          React.createElement(
            'section',
            { className: 'dpr-loadHero' },
            React.createElement(
              'div',
              { className: 'dpr-mascotSlot' },
              mascot,
            ),
            React.createElement(
              'div',
              { className: 'dpr-loadCopy' },
              React.createElement('div', { className: 'dpr-eyebrow' }, t('import.eyebrow')),
              React.createElement(
                'h2',
                { className: 'dpr-question' },
                failed ? t('import.failed') : done ? t('import.done') : t('import.wait'),
              ),
              React.createElement(
                'p',
                { className: 'dpr-sub' },
                job.originalName ? t('import.selected') + job.originalName : job.message,
              ),
            ),
          ),
          running
            ? React.createElement(
                'div',
                { className: 'dpr-timerRow' },
                React.createElement('span', null, t('import.timer')),
                React.createElement('span', { className: 'dpr-timer' }, formatDuration(elapsed)),
              )
            : null,
          React.createElement('ul', { className: 'dpr-stages' }, stages),
          failed
            ? React.createElement(
                'div',
                { className: 'dpr-error', role: 'alert' },
                React.createElement('span', { 'aria-hidden': true }, '⚠'),
                React.createElement('span', null, job.error || job.message),
              )
            : null,
          done && job.coverage
            ? React.createElement(
                'p',
                { className: 'dpr-fileMeta' },
                t('reader.coverage') + ' ' + Math.round((Number(job.coverage.characterRatio) || 0) * 10000) / 100 + '%',
              )
            : null,
          done
            ? React.createElement(
                'button',
                { type: 'button', className: 'dpr-primary', onClick: onOpenReader },
                t('import.openReader'),
              )
            : null,
          done || failed
            ? React.createElement(
                'button',
                { type: 'button', className: 'dpr-back', onClick: onReset },
                t('import.newFile'),
              )
            : null,
          running ? React.createElement('p', { className: 'dpr-bgNote' }, t('import.background')) : null,
          React.createElement(
            'button',
            { type: 'button', className: 'dpr-back', onClick: onBack },
            t('path.back'),
          ),
        ),
      )
    }

    function useAnnotations() {
      const { useState, useEffect } = React
      const [items, setItems] = useState(() => annotationStore.getSnapshot())
      useEffect(() => annotationStore.subscribe(setItems), [])
      return items
    }

    function useComparison() {
      const { useState, useEffect } = React
      const [state, setState] = useState(() => comparisonStore.getSnapshot())
      useEffect(() => comparisonStore.subscribe(setState), [])
      return state
    }

    /** 从七字段表抽一条「问题 → 方法 → 结果 / 局限」的论证链；不额外调模型。 */
    function buildLogicArtifact(table, digests) {
      const field = (key) => table?.fields?.find((item) => item.key === key)
      const cell = (key, index) => field(key)?.cells?.[index] || { text: '未找到', blockIds: [] }
      return {
        id: 'logic',
        type: 'diagram',
        title: '论证链对照',
        payload: {
          papers: digests.map((digest, index) => ({
            jobId: digest.jobId,
            title: digest.title,
            question: cell('question', index),
            method: cell('method', index),
            result: cell('result', index),
            limitation: cell('limitation', index),
          })),
        },
      }
    }

    /** 用档案里的真实计数做文献结构图，不伪造数据。 */
    function buildStructureArtifact(digests) {
      return {
        id: 'structure',
        type: 'chart',
        title: '文献结构对比',
        payload: {
          series: digests.map((digest) => ({
            jobId: digest.jobId,
            title: digest.title,
            figures: digest.counts.figures,
            tables: digest.counts.tables,
            equations: digest.counts.equations,
            references: digest.counts.references,
          })),
        },
      }
    }

    /** 证据覆盖度图：只用七字段表的真实定位状态，不生成新数据。 */
    function buildCoverageArtifact(table, digests) {
      const series = digests.map((digest, index) => {
        let grounded = 0
        let missing = 0
        let ungrounded = 0
        for (const field of table?.fields || []) {
          const cell = field.cells?.[index]
          if (!cell) continue
          if (cell.missing) missing += 1
          else if (cell.grounded) grounded += 1
          else ungrounded += 1
        }
        return {
          jobId: digest.jobId,
          title: digest.title,
          grounded,
          missing,
          ungrounded,
          total: grounded + missing + ungrounded,
        }
      })
      return {
        id: 'coverage',
        type: 'chart',
        title: '证据覆盖度',
        payload: { mode: 'coverage', series },
      }
    }

    /** 把七字段表转成可粘贴的 Markdown；blockId 保留在单元格末尾。 */
    function tableToMarkdown(table) {
      if (!table?.fields?.length) return ''
      const escape = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim()
      const papers = (table.fields[0].cells || []).map(
        (cell, index) => 'P' + (index + 1) + ' ' + escape(cell.title),
      )
      const lines = [
        '| 字段 | ' + papers.join(' | ') + ' |',
        '| --- | ' + papers.map(() => '---').join(' | ') + ' |',
      ]
      for (const field of table.fields) {
        const cells = field.cells.map((cell) => {
          const anchors = cell.blockIds?.length ? ' (' + cell.blockIds.join(', ') + ')' : ''
          return escape(cell.text) + anchors
        })
        lines.push('| ' + field.label + ' | ' + cells.join(' | ') + ' |')
      }
      return lines.join('\n')
    }

    /** 汇总成一份可带走的 Markdown 对照报告。 */
    function buildCompareReport({
      digests = [],
      table = null,
      annotations = [],
      messages = [],
      citation = null,
      mode = 'survey',
    }) {
      const lines = ['# 论文对照报告', '', '模式：' + (mode === 'citation' ? '引用对照' : '多篇综述'), '']
      lines.push('## 论文')
      digests.forEach((digest, index) => {
        lines.push(
          '- **P' +
            (index + 1) +
            '** 《' +
            digest.title +
            '》' +
            (digest.year ? ' · ' + digest.year : '') +
            (digest.doi ? ' · DOI ' + digest.doi : '') +
            (digest.arxiv ? ' · arXiv ' + digest.arxiv : '') +
            ' · jobId `' +
            digest.jobId +
            '`',
        )
      })
      if (table?.fields?.length) {
        lines.push('', '## 七字段对照表', '', tableToMarkdown(table))
        const coverage = digests.map((digest, index) => {
          let grounded = 0
          let missing = 0
          let ungrounded = 0
          for (const field of table.fields) {
            const cell = field.cells?.[index]
            if (!cell) continue
            if (cell.missing) missing += 1
            else if (cell.grounded) grounded += 1
            else ungrounded += 1
          }
          return { title: digest.title, grounded, missing, ungrounded }
        })
        lines.push(
          '',
          '## 证据覆盖度',
          '',
          '| 论文 | 已定位 | 未找到 | 未定位 |',
          '| --- | --- | --- | --- |',
          ...coverage.map(
            (item) =>
              '| ' +
              item.title.replace(/\|/g, '\\|') +
              ' | ' +
              item.grounded +
              ' | ' +
              item.missing +
              ' | ' +
              item.ungrounded +
              ' |',
          ),
        )
      }
      if (citation) {
        lines.push(
          '',
          '## 引用支持关系',
          '',
          '- 结论：' + (citation.label || citation.verdict || '未判定'),
          citation.claim ? '- A 的主张：' + citation.claim : '',
          citation.citedContribution ? '- B 的实际内容：' + citation.citedContribution : '',
          citation.gap ? '- 缺口：' + citation.gap : '',
          citation.nextSection ? '- 建议核对：' + citation.nextSection : '',
        )
      }
      const jobIds = new Set(digests.map((digest) => digest.jobId))
      const notes = annotations.filter((item) => jobIds.has(item.jobId)).slice(0, 20)
      if (notes.length > 0) {
        lines.push('', '## 批注')
        notes.forEach((item, index) => {
          const segment = item.segments?.[0] || {}
          lines.push(
            '- **批注 ' +
              (index + 1) +
              '** 《' +
              (item.context?.paper?.title || item.jobId) +
              '》 · p.' +
              (segment.page || '?') +
              ' · ' +
              (segment.section || '正文') +
              (segment.blockId ? ' · `' + segment.blockId + '`' : ''),
            '  - 问题：' + (item.question || '（只标记）'),
            '  - 原文：「' + String(segment.quote || '').slice(0, 240) + '」',
          )
        })
      }
      const recent = (messages || []).slice(-8)
      if (recent.length > 0) {
        lines.push('', '## 工作台对话')
        for (const message of recent) {
          lines.push('', '**' + (message.role === 'user' ? '陛下' : '大肥鱼') + '：**', '', String(message.content || ''))
        }
      }
      lines.push(
        '',
        '---',
        '生成时间：' + new Date().toISOString(),
        '说明：blockId 指向 MirrorDoc 原段；未定位/未找到的单元格仍需回原文核对。',
      )
      return lines.filter((line) => line !== null).join('\n')
    }

    /** 把人工修订叠到对照表上；键是 `fieldKey|jobId`。 */
    function applyTableEdits(table, edits) {
      if (!table?.fields?.length || !edits || typeof edits !== 'object') return table
      return {
        ...table,
        fields: table.fields.map((field) => ({
          ...field,
          cells: field.cells.map((cell) => {
            const key = field.key + '|' + cell.jobId
            if (!(key in edits)) return cell
            return { ...cell, text: String(edits[key] ?? ''), edited: true }
          }),
        })),
      }
    }

    function tableEditStorageKey(key) {
      return String(key || '') + ':tableEdits'
    }

    function loadTableEdits(key) {
      try {
        const raw = window.localStorage?.getItem(tableEditStorageKey(key))
        const value = raw ? JSON.parse(raw) : null
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
      } catch {
        return {}
      }
    }

    // Plague 这类整页旋转表：Pdfium 文本层按固定 32 列确定性拆分。
    const ROTATED_HEADER = [
      '菌株',
      '菌种',
      '州',
      '年份',
      '来源',
      '耐药表型',
      ...Array(13).fill(''),
      'IncA/C PCR 谱',
      ...Array(11).fill(''),
      '接合转移频率',
    ]
    const ROTATED_SUBHEADER = [
      '',
      '',
      '',
      '',
      '',
      'A',
      'C',
      'S',
      'Su',
      'T',
      'Ti',
      'G',
      'K',
      'Ag',
      'Ax',
      'N',
      'Ak',
      'Cp',
      'Sxt',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
      '11',
      '12',
      '',
    ]
    const ROTATED_SOURCE_LABELS = {
      Turkey: '火鸡肉',
      Chicken: '鸡肉',
      Beef: '牛肉',
      Pork: '猪肉',
      Calf: '犊牛',
    }

    function parseRotatedTableText(text) {
      const lines = String(text || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      const rows = [
        { header: true, cells: [...ROTATED_HEADER] },
        { header: true, cells: [...ROTATED_SUBHEADER] },
      ]
      for (const line of lines) {
        const match = /^(\S+)\s+(.+?)\s+([A-Z]{2})\s+(\d{4})\s+(\S+)\s+(.+)$/.exec(line)
        if (!match) continue
        const [, strain, organism, state, year, source, rest] = match
        const tokens = rest.split(/\s+/).filter(Boolean)
        if (tokens.length < 26) continue
        const phenotype = tokens.slice(0, 14)
        let cursor = 14
        const pcr = []
        while (cursor < tokens.length && pcr.length < 12) {
          const token = tokens[cursor++]
          if (/^-+$/.test(token)) pcr.push(...Array.from({ length: token.length }, () => '-'))
          else if (token === '10' || token === '11' || token === '12') pcr.push(token)
          else if (/^[1-9]+$/.test(token) && token.length > 1) pcr.push(...token.split(''))
          else if (/^[1-9]$/.test(token)) pcr.push(token)
          else break
        }
        if (pcr.length !== 12) continue
        rows.push({
          header: false,
          cells: [
            strain,
            organism,
            state,
            year,
            ROTATED_SOURCE_LABELS[source] || source,
            ...phenotype,
            ...pcr,
            tokens.slice(cursor).join(' ') || '-',
          ],
        })
      }
      return rows.length > 2 ? rows : []
    }

    function downloadTextFile(filename, text) {
      try {
        const blob = new Blob([String(text || '')], { type: 'text/markdown;charset=utf-8' })
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = filename
        link.click()
        window.setTimeout(() => URL.revokeObjectURL(url), 1200)
      } catch {
        // 浏览器阻止下载时仍可复制 Markdown。
      }
    }

    function artifactIcon(type) {
      return { table: '▦', diagram: '⇄', chart: '▥', concept: '◇', summary: '✎' }[type] || '▣'
    }

    /** 极简 Markdown：标题、粗体、行内代码、列表、表格、分隔线；不引第三方库。 */
    function renderMarkdownInline(text, prefix) {
      const parts = String(text || '').split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
      return parts.map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          return React.createElement('strong', { key: prefix + 'b' + index }, part.slice(2, -2))
        }
        if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
          return React.createElement('code', { key: prefix + 'c' + index, className: 'dpr-cmpMdCode' }, part.slice(1, -1))
        }
        return part
      })
    }

    function renderMarkdown(text) {
      const lines = String(text || '').split(/\r?\n/)
      const nodes = []
      let list = []
      let table = []
      const flushList = () => {
        if (list.length === 0) return
        nodes.push(
          React.createElement(
            'ul',
            { key: 'ul' + nodes.length, className: 'dpr-cmpMdList' },
            list.map((item, index) =>
              React.createElement('li', { key: index }, renderMarkdownInline(item, 'li' + index)),
            ),
          ),
        )
        list = []
      }
      const flushTable = () => {
        if (table.length === 0) return
        if (table.length < 2) {
          nodes.push(
            React.createElement(
              'p',
              { key: 'tp' + nodes.length, className: 'dpr-cmpMdP' },
              renderMarkdownInline(table.join(' '), 'tp' + nodes.length),
            ),
          )
          table = []
          return
        }
        const rows = table.map((line) =>
          line
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((cell) => cell.trim()),
        )
        const header = rows[0]
        const body = rows.slice(2)
        nodes.push(
          React.createElement(
            'div',
            { key: 'tw' + nodes.length, className: 'dpr-cmpMdTableWrap' },
            React.createElement(
              'table',
              { className: 'dpr-cmpMdTable' },
              React.createElement(
                'thead',
                null,
                React.createElement(
                  'tr',
                  null,
                  header.map((cell, index) =>
                    React.createElement('th', { key: index }, renderMarkdownInline(cell, 'th' + index)),
                  ),
                ),
              ),
              React.createElement(
                'tbody',
                null,
                body.map((row, rowIndex) =>
                  React.createElement(
                    'tr',
                    { key: rowIndex },
                    row.map((cell, cellIndex) =>
                      React.createElement(
                        'td',
                        { key: cellIndex },
                        renderMarkdownInline(cell, 'td' + rowIndex + '-' + cellIndex),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        )
        table = []
      }
      for (const rawLine of lines) {
        const line = rawLine.replace(/\s+$/, '')
        if (/^\s*\|.*\|\s*$/.test(line)) {
          flushList()
          table.push(line)
          continue
        }
        flushTable()
        if (/^#{1,4}\s+/.test(line)) {
          flushList()
          const level = Math.min(4, (line.match(/^#+/) || ['#'])[0].length)
          nodes.push(
            React.createElement(
              'h' + (level + 2),
              { key: 'h' + nodes.length, className: 'dpr-cmpMdH' },
              renderMarkdownInline(line.replace(/^#{1,4}\s+/, ''), 'h' + nodes.length),
            ),
          )
          continue
        }
        if (/^\s*[-*]\s+/.test(line)) {
          list.push(line.replace(/^\s*[-*]\s+/, ''))
          continue
        }
        if (/^\s*\d+\.\s+/.test(line)) {
          list.push(line.replace(/^\s*\d+\.\s+/, ''))
          continue
        }
        if (/^\s*>\s?/.test(line)) {
          flushList()
          nodes.push(
            React.createElement(
              'blockquote',
              { key: 'q' + nodes.length, className: 'dpr-cmpMdQuote' },
              renderMarkdownInline(line.replace(/^\s*>\s?/, ''), 'q' + nodes.length),
            ),
          )
          continue
        }
        if (/^\s*---+\s*$/.test(line)) {
          flushList()
          nodes.push(React.createElement('hr', { key: 'hr' + nodes.length, className: 'dpr-cmpMdHr' }))
          continue
        }
        if (!line.trim()) {
          flushList()
          continue
        }
        flushList()
        nodes.push(
          React.createElement(
            'p',
            { key: 'p' + nodes.length, className: 'dpr-cmpMdP' },
            renderMarkdownInline(line, 'p' + nodes.length),
          ),
        )
      }
      flushList()
      flushTable()
      return nodes
    }

    let katexPromise = null

    /** 按需加载随包的 KaTeX（MIT，assets/vendor/katex），失败时回退 SVG/原图。 */
    function ensureKatex() {
      if (typeof window === 'undefined' || typeof document === 'undefined') {
        return Promise.reject(new Error('no-dom'))
      }
      if (window.katex) return Promise.resolve(window.katex)
      if (katexPromise) return katexPromise
      katexPromise = new Promise((resolve, reject) => {
        const link = document.createElement('link')
        link.rel = 'stylesheet'
        link.href = 'doraemon-paper-reader/vendor/katex/katex.min.css'
        document.head.appendChild(link)
        const script = document.createElement('script')
        script.src = 'doraemon-paper-reader/vendor/katex/katex.min.js'
        script.async = true
        script.onload = () => (window.katex ? resolve(window.katex) : reject(new Error('katex missing')))
        script.onerror = () => reject(new Error('katex load failed'))
        document.head.appendChild(script)
      })
      return katexPromise
    }

    function sanitizeKatex(latex) {
      let value = String(latex || '')
        .replace(/\\tag\{[^}]*\}/g, '')
        .replace(/\\begin\{split\}|\\end\{split\}/g, '')
        .replace(/\\begin\{align\}|\\end\{align\}/g, '')
        .trim()
      if (value.includes('\\\\')) value = '\\begin{aligned}' + value + '\\end{aligned}'
      return value
    }

    /** 浏览器内 KaTeX 渲染；失败时回退到 SVG/公式裁剪图。 */
    function KatexFormula({ latex, fallbackSrc, label }) {
      const { useRef, useState, useEffect } = React
      const ref = useRef(null)
      const [failed, setFailed] = useState(false)
      useEffect(() => {
        let alive = true
        setFailed(false)
        ensureKatex()
          .then((katex) => {
            if (!alive || !ref.current) return
            katex.render(sanitizeKatex(latex), ref.current, {
              displayMode: true,
              throwOnError: true,
              strict: 'ignore',
            })
          })
          .catch(() => {
            if (alive) setFailed(true)
          })
        return () => {
          alive = false
        }
      }, [latex])
      if (failed && fallbackSrc) {
        return React.createElement('img', {
          src: fallbackSrc,
          alt: label || '排版公式',
          className: 'dpr-cmpFormulaSvg',
        })
      }
      return React.createElement('div', { ref, className: 'dpr-cmpKatex', 'aria-label': label || '排版公式' })
    }

    /**
     * 主对话输入区上方的批注条：只负责收集/编辑批注，不单独发送。
     * 用户在主输入框写问题后按回车或点宿主发送键，批注会随这条消息一起走。
     * @param {object} props - 槽位 props（注入 submitDraft）。
     * @returns {object|null} React 元素。
     */
    function ComposerAnnotations(props) {
      const { useState, useEffect, useRef } = React
      const items = useAnnotations()
      const [open, setOpen] = useState(true)
      const [status, setStatus] = useState('')
      const pending = items.filter((item) => !item.sent)
      const paperCount = new Set(
        pending.map((item) => item.context?.paper?.doi || item.context?.paper?.title || item.jobId),
      ).size
      const pendingRef = useRef(pending)
      pendingRef.current = pending
      const propsRef = useRef(props)
      propsRef.current = props
      const sendingRef = useRef(false)

      const annotationPlace = (item) => {
        if (item.segments.length > 1) return item.segments.length + ' 段'
        const first = item.segments[0] || {}
        if (first.kind && first.kind !== 'text') {
          const kindLabel = { figure: '图', table: '表格', equation: '公式' }[first.kind] || first.kind
          return first.label || kindLabel
        }
        return first.section || '正文'
      }

      const annotationPaper = (item) => {
        const title = String(item.context?.paper?.title || '').trim()
        if (!title) return ''
        return title.length > 28 ? title.slice(0, 27) + '…' : title
      }

      // 多篇批注要能一起发：进入会话时把论文库里各篇的未发送批注读回内存。
      useEffect(() => {
        if (typeof window === 'undefined' || !window.location || typeof fetch !== 'function') return undefined
        let alive = true
        fetch(apiUrl('library'), { cache: 'no-store' })
          .then(async (response) => {
            const payload = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(payload.error || response.statusText)
            const papers = Array.isArray(payload.papers) ? payload.papers : []
            for (const paper of papers) {
              if (alive) void annotationStore.loadForJob(paper.jobId)
            }
          })
          .catch(() => {
            // 论文库暂时读不到时，当前阅读页仍会按需读回自己的批注。
          })
        return () => {
          alive = false
        }
      }, [])

      const attachAndSubmit = async () => {
        const current = pendingRef.current
        if (current.length === 0 || sendingRef.current) return
        const latest = propsRef.current
        const draft = String(latest.input?.draft || '')
        if (!latest.submitDraft) {
          setStatus(latest.t('reader.askNoSession'))
          return
        }
        if (draft.trimStart().startsWith('/')) {
          setStatus('命令消息不携带批注；批注会留到下一条普通消息。')
          return
        }
        sendingRef.current = true
        setStatus('正在把 ' + current.length + ' 个批注挂到这条消息…')
        const packet = {
          type: 'doraemon-annotations',
          // 主输入框里的文字就是这次批注的整体问题。
          question: draft,
          annotations: current.map((item, index) => ({
            index: index + 1,
            jobId: item.jobId,
            question: item.question,
            context: item.context,
            segments: item.segments,
          })),
        }
        try {
          // 完整包先交给宿主暂存；聊天里只出现可读的「批注 1 / 批注 2」摘要。
          const response = await fetch(apiUrl('annotation-batches'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(packet),
          })
          const saved = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(saved.error || response.statusText || '批注保存失败')
          if (!saved.message) throw new Error('宿主没有返回批注摘要')
          await latest.submitDraft(saved.message, latest.sessionId)
          annotationStore.markSent(current.map((item) => item.id))
          setStatus('已随主消息发送 ' + current.length + ' 个批注（批注 1–' + current.length + '）。')
        } catch (cause) {
          setStatus(latest.t('reader.askFailed') + (cause?.message || String(cause)))
        } finally {
          sendingRef.current = false
        }
      }

      useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const isComposerInput = (target) => Boolean(target?.closest?.('[data-composer-input]'))
        const isSendButton = (target) => {
          const button = target?.closest?.('button')
          if (!button || button.disabled || !button.closest?.('[data-composer-card]')) return false
          const label = button.getAttribute('aria-label') || ''
          return /^(发送|Send)/i.test(label)
        }
        const onKeyDown = (event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
          if (event.isComposing || event.keyCode === 229) return
          if (!isComposerInput(event.target) || pendingRef.current.length === 0) return
          if (String(propsRef.current.input?.draft || '').trimStart().startsWith('/')) return
          event.preventDefault()
          event.stopPropagation()
          void attachAndSubmit()
        }
        const onClick = (event) => {
          if (!isSendButton(event.target) || pendingRef.current.length === 0) return
          if (String(propsRef.current.input?.draft || '').trimStart().startsWith('/')) return
          event.preventDefault()
          event.stopPropagation()
          void attachAndSubmit()
        }
        document.addEventListener('keydown', onKeyDown, true)
        document.addEventListener('click', onClick, true)
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          document.removeEventListener('click', onClick, true)
        }
      }, [])

      if (pending.length === 0) {
        return status ? React.createElement('div', { className: 'dpr-annotationDock' }, status) : null
      }

      return React.createElement(
        'div',
        { className: 'dpr-annotationDock' },
        React.createElement(
          'div',
          { className: 'dpr-annotationHead' },
          React.createElement(
            'button',
            { type: 'button', className: 'dpr-annotationSummary', onClick: () => setOpen((value) => !value) },
            '📎 ' + pending.length + ' 个批注' + (paperCount > 1 ? ' · ' + paperCount + ' 篇论文' : ''),
          ),
          React.createElement('span', { className: 'dpr-annotationMeta' }, '会随主输入框一起发送'),
        ),
        open
          ? React.createElement(
              React.Fragment,
              null,
              React.createElement(
                'div',
                { className: 'dpr-annotationList' },
                pending.map((item, index) => {
                  const first = item.segments[0] || {}
                  return React.createElement(
                    'div',
                    { key: item.id, className: 'dpr-annotationItem' },
                    React.createElement(
                      'div',
                      { className: 'dpr-annotationMeta' },
                      '批注 ' +
                        (index + 1) +
                        ' · p.' +
                        (first.page || '?') +
                        ' · ' +
                        (paperCount > 1 && annotationPaper(item) ? '《' + annotationPaper(item) + '》 · ' : '') +
                        annotationPlace(item),
                      React.createElement(
                        'button',
                        { type: 'button', onClick: () => annotationStore.remove(item.id) },
                        '删除',
                      ),
                    ),
                    React.createElement('textarea', {
                      value: item.question,
                      'aria-label': '批注问题 ' + (index + 1),
                      placeholder: props.t('reader.notePlaceholder'),
                      onChange: (event) => annotationStore.update(item.id, { question: event.target.value }),
                    }),
                  )
                }),
              ),
              React.createElement(
                'span',
                { className: 'dpr-annotationHint' },
                '在主输入框写问题，按回车或点发送即可带上这些批注；没有问题时按回车也能只发批注。',
              ),
            )
          : null,
        status ? React.createElement('span', { className: 'dpr-annotationMeta' }, status) : null,
      )
    }

    /**
     * 全宽对照视图（shell.overlay）。两种模式共用一套论文卡：
     *   - survey：2–3 篇 + 七字段对照表；
     *   - citation：引用方 [n] 原文 + 被引论文 + 支持度判断。
     * 视图本身不读整篇论文，只读宿主给的 digest；点击 blockId 才回阅读页。
     * @param {object} props - 槽位 props（注入 submitDraft / openReader / t）。
     * @returns {object|null} React 元素。
     */
    /**
     * 对照视图里的一篇论文：全文阅读、选区批注、引用蓝链。
     * 与单篇阅读页共用 MirrorDoc / citation index / annotation store；
     * 翻译、术语、公式视觉等高级功能不在这一层重复实现，后续同步。
     */
    function PaperPane(props) {
      const { useState, useEffect, useRef } = React
      const { jobId, tag, digest, annotations, onCite, onOpenReader, onFocusAnnotation, onAnnotationSaved } = props
      const [doc, setDoc] = useState(null)
      const [citationIndex, setCitationIndex] = useState(null)
      const [error, setError] = useState('')
      const [sel, setSel] = useState(null)
      const [draft, setDraft] = useState('')
      const [saving, setSaving] = useState(false)
      const [termLookup, setTermLookup] = useState(null)
      const [langMode, setLangMode] = useState(() => {
        try {
          return (jobId && window.localStorage?.getItem(LANG_STORAGE_PREFIX + jobId)) || 'original'
        } catch {
          return 'original'
        }
      })
      const [translations, setTranslations] = useState(null)
      const [translationState, setTranslationState] = useState(null)
      const [translationNonce, setTranslationNonce] = useState(0)
      const [formulaData, setFormulaData] = useState(null)
      const [formulaRenders, setFormulaRenders] = useState({})
      const [tableData, setTableData] = useState(null)
      const [glossaryOpen, setGlossaryOpen] = useState(false)
      const [glossaryEntries, setGlossaryEntries] = useState([])
      const [glossarySaving, setGlossarySaving] = useState(false)
      const [glossaryError, setGlossaryError] = useState('')
      const bodyRef = useRef(null)
      const forceTranslateRef = useRef(false)

      useEffect(() => {
        if (!jobId) return undefined
        let alive = true
        setDoc(null)
        setCitationIndex(null)
        setError('')
        fetch(apiUrl('jobs/' + jobId + '/mirrordoc.json'), { cache: 'no-store' })
          .then(async (response) => {
            const payload = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(payload.error || response.statusText)
            if (alive) setDoc(payload)
          })
          .catch((cause) => {
            if (alive) setError(cause?.message || String(cause))
          })
        fetch(apiUrl('jobs/' + jobId + '/citations'), { cache: 'no-store' })
          .then(async (response) => {
            if (!response.ok) return null
            return response.json()
          })
          .then((payload) => {
            if (alive) setCitationIndex(payload || null)
          })
          .catch(() => {
            if (alive) setCitationIndex(null)
          })
        return () => {
          alive = false
        }
      }, [jobId])

      useEffect(() => {
        if (!jobId) return undefined
        let alive = true
        setFormulaData(null)
        setFormulaRenders({})
        setTableData(null)
        fetch(apiUrl('jobs/' + jobId + '/formulas'), { cache: 'no-store' })
          .then((response) => (response.ok ? response.json() : null))
          .then((payload) => {
            if (alive) setFormulaData(payload)
          })
          .catch(() => {
            if (alive) setFormulaData(null)
          })
        fetch(apiUrl('jobs/' + jobId + '/tables'), { cache: 'no-store' })
          .then((response) => (response.ok ? response.json() : null))
          .then((payload) => {
            if (alive) setTableData(payload)
          })
          .catch(() => {
            if (alive) setTableData(null)
          })
        return () => {
          alive = false
        }
      }, [jobId])

      useEffect(() => {
        if (!jobId || !formulaData?.blocks || Object.keys(formulaData.blocks).length === 0) return undefined
        let alive = true
        fetch(apiUrl('jobs/' + jobId + '/formula-render'), { method: 'POST' })
          .then(async (response) => {
            if (!response.ok) return null
            return response.json()
          })
          .then((payload) => {
            if (alive && payload?.renders) setFormulaRenders(payload.renders)
          })
          .catch(() => {
            // 渲染失败时保留原图与 LaTeX 源码。
          })
        return () => {
          alive = false
        }
      }, [jobId, formulaData])

      useEffect(() => {
        if (!jobId || langMode === 'original') {
          setTranslations(null)
          setTranslationState(null)
          return undefined
        }
        let alive = true
        let timer = 0
        const load = async () => {
          const response = await fetch(apiUrl('jobs/' + jobId + '/translations'), { cache: 'no-store' })
          if (!response.ok) return false
          const payload = await response.json().catch(() => null)
          if (!payload || !alive) return false
          setTranslations(payload)
          setTranslationState({ status: 'done', done: 0, total: 0 })
          return true
        }
        const poll = async () => {
          try {
            const response = await fetch(apiUrl('jobs/' + jobId + '/translate'), { cache: 'no-store' })
            const payload = await response.json().catch(() => ({}))
            if (!alive) return
            if (response.ok) setTranslationState(payload)
            if (payload.status === 'done') {
              await load()
              return
            }
            if (payload.status === 'failed') return
          } catch {
            // 网络抖动时下一轮继续。
          }
          if (alive) timer = window.setTimeout(poll, 1200)
        }
        const start = async () => {
          try {
            const response = await fetch(apiUrl('jobs/' + jobId + '/translate'), { cache: 'no-store' })
            let payload = await response.json().catch(() => ({}))
            if (!alive) return
            if (response.ok && payload.status === 'done') {
              await load()
              return
            }
            if (response.ok && payload.status === 'running') {
              setTranslationState(payload)
              timer = window.setTimeout(poll, 1200)
              return
            }
            const started = await fetch(apiUrl('jobs/' + jobId + '/translate'), { method: 'POST' })
            payload = await started.json().catch(() => ({}))
            if (!alive) return
            if (!started.ok) {
              setTranslationState({ status: 'failed', message: payload.error || '翻译启动失败' })
              return
            }
            setTranslationState(payload)
            if (payload.status === 'done') await load()
            else if (payload.status !== 'failed') timer = window.setTimeout(poll, 1200)
          } catch (cause) {
            if (alive) setTranslationState({ status: 'failed', message: cause?.message || String(cause) })
          }
        }
        if (forceTranslateRef.current) {
          forceTranslateRef.current = false
          void start()
        } else {
          load().then((ready) => {
            if (!ready && alive) void start()
          })
        }
        return () => {
          alive = false
          window.clearTimeout(timer)
        }
      }, [jobId, langMode, translationNonce])

      const blocks = Array.isArray(doc?.blocks) ? doc.blocks : []
      const skipText = new Set(
        [doc?.meta?.title, doc?.meta?.abstract, 'Article']
          .filter(Boolean)
          .map((value) => String(value).replace(/\s+/g, '')),
      )
      // 摘要框已经单独展示；正文从第一个章节标题开始，避免标题/摘要重复一遍。
      const firstHeading = blocks.findIndex(
        (block) => block.type === 'heading' && String(block.text || '').trim().length > 0,
      )
      const contentBlocks = firstHeading >= 0 ? blocks.slice(firstHeading) : blocks
      const visibleBlocks = contentBlocks.filter(
        (block) => !skipText.has(String(block.text || '').replace(/\s+/g, '')),
      )
      const countFor = (blockId) =>
        annotations.filter(
          (item) => item.jobId === jobId && item.segments?.some((segment) => segment.blockId === blockId),
        ).length

      const renderTarget = (block, translated) => {
        const segments = Array.isArray(translated?.segments) ? translated.segments : []
        if (segments.length === 0) return translated?.text || ''
        return segments.map((segment, segmentIndex) => {
          const target = String(segment.target || '')
          const spans = Array.isArray(segment.targetSpans) ? segment.targetSpans : []
          if (spans.length === 0) {
            return React.createElement('span', { key: 'ts' + segmentIndex }, target)
          }
          return splitCitationText(target, spans).map((part, index) => {
            if (part.type === 'text') {
              return React.createElement('span', { key: 'tt' + segmentIndex + '-' + index }, part.text)
            }
            const number = part.span.numbers?.[0]
            const reference = (citationIndex?.references || []).find((item) => item.number === number)
            return React.createElement(
              'button',
              {
                key: 'tc' + segmentIndex + '-' + index,
                type: 'button',
                className: 'dpr-cmpCiteLink',
                title: '查看这条引用',
                onClick: (event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  onCite({
                    jobId,
                    block,
                    span: { ...part.span, originalStart: 0, originalEnd: 0 },
                    reference,
                    doc,
                  })
                },
              },
              part.text,
            )
          })
        })
      }

      const blockMarkRanges = (block) => {
        const source = String(block.text || '')
        const ranges = []
        for (const item of annotations) {
          if (item.jobId !== jobId) continue
          for (const segment of item.segments || []) {
            if (segment.blockId !== block.id || !segment.quote) continue
            const index = source.indexOf(String(segment.quote))
            if (index >= 0) {
              ranges.push({ start: index, end: index + String(segment.quote).length })
            }
          }
        }
        return ranges
      }

      const renderSource = (block) => {
        const source = String(block.text || '')
        const spans = citationIndex?.byBlock?.[block.id] || []
        const marks = blockMarkRanges(block)
        const boundaries = new Set([0, source.length])
        for (const span of spans) {
          boundaries.add(Math.max(0, Math.min(source.length, Number(span.start) || 0)))
          boundaries.add(Math.max(0, Math.min(source.length, Number(span.end) || 0)))
        }
        for (const range of marks) {
          boundaries.add(range.start)
          boundaries.add(range.end)
        }
        const sorted = [...boundaries].sort((a, b) => a - b)
        const nodes = []
        for (let index = 0; index < sorted.length - 1; index += 1) {
          const start = sorted[index]
          const end = sorted[index + 1]
          if (end <= start) continue
          const text = source.slice(start, end)
          const citation = spans.find(
            (span) => Number(span.start) <= start && Number(span.end) >= end,
          )
          const marked = marks.some((range) => start >= range.start && end <= range.end)
          if (citation) {
            const number = citation.numbers?.[0]
            const reference = (citationIndex?.references || []).find((item) => item.number === number)
            nodes.push(
              React.createElement(
                'button',
                {
                  key: 'c' + start,
                  type: 'button',
                  className: 'dpr-cmpCiteLink' + (marked ? ' dpr-cmpMarkLink' : ''),
                  title: '查看这条引用',
                  onClick: (event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    onCite({ jobId, block, span: citation, reference, doc })
                  },
                },
                text,
              ),
            )
          } else if (marked) {
            nodes.push(React.createElement('mark', { key: 'm' + start, className: 'dpr-cmpMark' }, text))
          } else {
            nodes.push(React.createElement('span', { key: 't' + start }, text))
          }
        }
        return nodes
      }

      const renderText = (block) => {
        const translated = translations?.blocks?.[block.id]
        if (langMode !== 'original' && translated) {
          if (langMode === 'zh') return renderTarget(block, translated)
          return [
            React.createElement('span', { key: 'src', className: 'dpr-cmpSource' }, block.text),
            React.createElement(
              'span',
              { key: 'tgt', className: 'dpr-cmpTarget' },
              renderTarget(block, translated),
            ),
          ]
        }
        return renderSource(block)
      }

      const annotationBadge = (block) => {
        const count = countFor(block.id)
        if (count === 0) return null
        return React.createElement(
          'button',
          {
            type: 'button',
            className: 'dpr-cmpBlockNote',
            title: '批注 ' + count + ' 条；点开工作台批注列表',
            onClick: (event) => {
              event.preventDefault()
              event.stopPropagation()
              onFocusAnnotation()
            },
          },
          '📝 ' + count,
        )
      }

      const copyText = (text) => {
        try {
          void navigator.clipboard?.writeText(String(text || ''))
        } catch {
          // 剪贴板不可用时仍能看到原文。
        }
      }

      const renderBlock = (block) => {
        if (!block?.id) return null
        if (block.type === 'reference') return null
        if (block.type === 'separator') {
          return React.createElement('hr', {
            key: block.id,
            id: block.id,
            className: 'dpr-readerSeparator',
            'data-block-id': block.id,
            'data-page': block.page,
            'data-rule-id': block.ruleId || '',
            'aria-hidden': 'true',
          })
        }
        const count = countFor(block.id)
        const className =
          'dpr-cmpBlock' +
          (block.type === 'heading' ? ' is-heading' : '') +
          (count > 0 ? ' is-annotated' : '')
        if (block.type === 'heading') {
          const translated = translations?.blocks?.[block.id]
          return React.createElement(
            block.level && block.level > 1 ? 'h4' : 'h3',
            { key: block.id, className: className, 'data-block-id': block.id },
            langMode === 'zh' && translated?.text ? translated.text : block.text,
          )
        }
        if (block.type === 'figure' || block.type === 'table' || block.type === 'equation') {
          const translated = translations?.blocks?.[block.id]
          const formula = block.type === 'equation' ? formulaData?.blocks?.[block.id] : null
          const renderedFormula = block.type === 'equation' ? formulaRenders?.[block.id] : null
          const formulaSvg =
            renderedFormula?.ok &&
            renderedFormula.file &&
            (!formula || Number(formula.confidence) >= 0.85)
              ? assetUrl(jobId, renderedFormula.file)
              : ''
          const tableTrans = block.type === 'table' ? tableData?.blocks?.[block.id] : null
          const parsedRows =
            tableTrans?.mode === 'structured' && block.tableText
              ? parseRotatedTableText(block.tableText)
              : []
          const displayRows = parsedRows.length > 0 ? parsedRows : tableTrans?.rows || []
          const caption =
            langMode === 'zh' && translated?.text
              ? translated.text
              : block.caption || block.text || ''
          return React.createElement(
            'figure',
            { key: block.id, className: className + ' dpr-cmpFigure', 'data-block-id': block.id },
            block.type === 'equation' && formula?.valid && formula.latex
              ? React.createElement(KatexFormula, {
                  latex: formula.latex,
                  fallbackSrc: formulaSvg || (block.asset ? assetUrl(jobId, block.asset) : ''),
                  label: block.label || block.caption || '排版公式',
                })
              : block.asset
                ? React.createElement('img', {
                    src: assetUrl(jobId, block.asset),
                    alt: block.label || block.caption || '论文插图',
                    loading: 'lazy',
                  })
                : null,
            React.createElement(
              'figcaption',
              null,
              (block.label ? block.label + '：' : '') + caption,
            ),
            formula && formula.valid && formula.latex
              ? React.createElement(
                  'details',
                  { className: 'dpr-cmpFormulaSource' },
                  React.createElement('summary', null, 'LaTeX 源码 · 置信度 ' + Math.round((Number(formula.confidence) || 0) * 100) + '%'),
                  React.createElement(
                    'div',
                    { className: 'dpr-cmpLatexBox' },
                    React.createElement('code', { className: 'dpr-cmpLatex' }, formula.latex),
                    React.createElement(
                      'button',
                      { type: 'button', className: 'dpr-back', onClick: () => copyText(formula.latex) },
                      '复制 LaTeX',
                    ),
                  ),
                )
              : formula && (!formula.valid || Number(formula.confidence) < 0.85)
                ? React.createElement(
                    'p',
                    { className: 'dpr-compareHint' },
                    '公式低置信度，已保留原图；可在单篇阅读页手动校正。',
                  )
                : null,
            tableTrans && tableTrans.valid && Array.isArray(tableTrans.rows) && langMode !== 'original'
              ? React.createElement(
                  'details',
                  { className: 'dpr-cmpTableTrans' },
                  React.createElement(
                    'summary',
                    null,
                    '表格译文（' +
                      displayRows.length +
                      ' 行，' +
                      (parsedRows.length > 0 ? '结构化拆分' : tableTrans.mode || '视觉') +
                      '）',
                  ),
                  displayRows.every((row) => Array.isArray(row.cells))
                    ? React.createElement(
                        'div',
                        { className: 'dpr-cmpTableGridWrap' },
                        React.createElement(
                          'table',
                          { className: 'dpr-cmpTableGrid' },
                          React.createElement(
                            'tbody',
                            null,
                            displayRows.map((row, rowIndex) =>
                              React.createElement(
                                'tr',
                                { key: 'tgr' + rowIndex },
                                (row.cells || []).map((cell, cellIndex) =>
                                  React.createElement(
                                    row.header ? 'th' : 'td',
                                    { key: 'tgc' + cellIndex },
                                    cell || '',
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      )
                    : React.createElement(
                        'pre',
                        { className: 'dpr-cmpTablePre' },
                        displayRows.map((row) => row.cells || '').join('\n'),
                      ),
                )
              : tableTrans && tableTrans.valid === false
                ? React.createElement(
                    'p',
                    { className: 'dpr-compareHint' },
                    '表格译文未通过校验，仅保留原表。',
                  )
                : null,
            annotationBadge(block),
          )
        }
        return React.createElement(
          'p',
          {
            key: block.id,
            className: className,
            'data-block-id': block.id,
            'data-source-text': block.text || '',
          },
          renderText(block),
          annotationBadge(block),
        )
      }

      const onMouseUp = () => {
        if (!doc || typeof window === 'undefined') return
        const selection = window.getSelection()
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return
        const range = selection.getRangeAt(0)
        const node = range.commonAncestorContainer
        const element = (node.nodeType === 1 ? node : node.parentElement)?.closest?.('[data-block-id]')
        if (!element || !bodyRef.current?.contains(element)) return
        const block = blocks.find((item) => item.id === element.dataset.blockId)
        if (!block) return
        const quote = selection.toString().replace(/\s+/g, ' ').trim()
        if (quote.length < 2) return
        const source = String(block.text || '')
        const start = source.indexOf(quote)
        const rect = range.getBoundingClientRect()
        setSel({
          block,
          quote,
          before: start >= 0 ? source.slice(Math.max(0, start - 180), start) : '',
          after: start >= 0 ? source.slice(start + quote.length, start + quote.length + 180) : '',
          rect,
        })
        setDraft('')
      }

      const saveAnnotation = async () => {
        if (!sel || saving) return
        setSaving(true)
        const block = sel.block
        annotationStore.add({
          jobId,
          question: draft,
          context: {
            paper: {
              title: doc?.meta?.title || digest?.title || '',
              doi: doc?.meta?.doi || digest?.doi || '',
              arxiv: doc?.meta?.arxivId || digest?.arxiv || '',
            },
            version: doc?.version || null,
            brief: { abstract: doc?.meta?.abstract || '' },
          },
          segments: [
            {
              quote: sel.quote,
              before: sel.before,
              after: sel.after,
              page: Number(block.page) || 0,
              blockId: block.id,
              section: block.section || '',
              kind: block.type === 'text' ? 'text' : block.type || 'text',
            },
          ],
        })
        setSaving(false)
        setSel(null)
        setDraft('')
        if (onAnnotationSaved) onAnnotationSaved()
      }

      const requestTermLookup = async (request) => {
        const source =
          request ||
          (sel
            ? {
                term: sel.quote,
                blockId: sel.block.id,
                before: sel.before,
                after: sel.after,
              }
            : null)
        if (!source || !jobId) return
        const requestId = String(Date.now()) + Math.random().toString(36).slice(2)
        setTermLookup({
          status: 'loading',
          term: source.term,
          rect: sel?.rect || termLookup?.rect,
          request: source,
          requestId,
        })
        setSel(null)
        try {
          const payload = await postApi('jobs/' + jobId + '/term-lookup', source)
          setTermLookup((current) =>
            current?.requestId === requestId
              ? { ...current, status: 'ready', result: payload }
              : current,
          )
        } catch (cause) {
          setTermLookup((current) =>
            current?.requestId === requestId
              ? { ...current, status: 'error', error: cause?.message || String(cause) }
              : current,
          )
        }
      }

      const locateTermBlock = (blockId) => {
        setTermLookup(null)
        const target = bodyRef.current?.querySelector('[data-block-id="' + blockId + '"]')
        if (!target) return
        target.scrollIntoView({ behavior: 'smooth', block: 'center' })
        target.classList.add('dpr-flash')
        window.setTimeout(() => target.classList.remove('dpr-flash'), 2200)
      }

      const cycleLang = () => {
        const next = langMode === 'original' ? 'zh' : langMode === 'zh' ? 'bilingual' : 'original'
        setLangMode(next)
        try {
          window.localStorage?.setItem(LANG_STORAGE_PREFIX + jobId, next)
        } catch {
          // 存储不可用时只影响记忆。
        }
      }

      const openGlossary = async () => {
        setGlossaryError('')
        try {
          const response = await fetch(apiUrl('jobs/' + jobId + '/glossary'), { cache: 'no-store' })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(payload.error || '读取术语表失败')
          setGlossaryEntries(payload.entries || [])
        } catch (cause) {
          setGlossaryEntries([])
          setGlossaryError(cause?.message || String(cause))
        }
        setGlossaryOpen(true)
      }

      const saveGlossary = async (entries) => {
        setGlossarySaving(true)
        setGlossaryError('')
        try {
          const response = await fetch(apiUrl('jobs/' + jobId + '/glossary'), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(payload.error || '保存术语表失败')
          setGlossaryEntries(payload.entries || [])
          setGlossaryOpen(false)
          if (langMode !== 'original') {
            forceTranslateRef.current = true
            setTranslations(null)
            setTranslationState({
              status: 'running',
              stage: 'start',
              message: '术语表已更新，准备重译…',
              done: 0,
              total: 0,
            })
            setTranslationNonce((value) => value + 1)
          }
        } catch (cause) {
          setGlossaryError(cause?.message || String(cause))
        } finally {
          setGlossarySaving(false)
        }
      }

      const title = doc?.meta?.title || digest?.title || '未命名论文'
      const displayTitle = langMode === 'zh' && translations?.meta?.title ? translations.meta.title : title
      const versionInfo = doc?.version || digest?.versionInfo || {}
      const versionName =
        versionInfo.kind === 'vor'
          ? 'VOR'
          : versionInfo.kind === 'preprint'
            ? '预印本'
            : versionInfo.kind === 'accepted'
              ? '录用稿'
              : '版本未核验'
      const abstractText =
        langMode === 'zh' && translations?.meta?.abstract ? translations.meta.abstract : doc?.meta?.abstract
      const meta = [doc?.meta?.authors || digest?.authors, doc?.meta?.doi || digest?.doi, doc?.meta?.arxivId || digest?.arxiv]
        .filter(Boolean)
        .join(' · ')
      const selectionStyle = sel
        ? {
            left: Math.max(12, Math.min((window.innerWidth || 1440) - 340, sel.rect.left)),
            top: Math.min((window.innerHeight || 900) - 220, Math.max(72, sel.rect.bottom + 8)),
          }
        : undefined

      return React.createElement(
        'section',
        { className: 'dpr-cmpPaperPane', 'data-pane-job': jobId },
        React.createElement(
          'header',
          { className: 'dpr-cmpPaperHead' },
          React.createElement(
            'div',
            { className: 'dpr-cmpPaperTitleRow' },
            React.createElement('span', { className: 'dpr-cmpPaperTag' }, tag),
            React.createElement('h3', null, displayTitle),
            React.createElement(
              'span',
              {
                className:
                  'dpr-cmpPaperVersion' +
                  (versionInfo.kind === 'vor'
                    ? ' is-vor'
                    : versionInfo.kind === 'preprint'
                      ? ' is-preprint'
                      : ''),
                title: versionInfo.label || versionName,
              },
              versionName,
            ),
          ),
          meta ? React.createElement('div', { className: 'dpr-cmpPaperMeta' }, meta) : null,
          React.createElement(
            'div',
            { className: 'dpr-cmpPaperActions' },
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dpr-cmpLangBtn' + (langMode !== 'original' ? ' is-active' : ''),
                onClick: cycleLang,
                title: '切换语言：原文 → 中文 → 对照',
              },
              langMode === 'original' ? '原文' : langMode === 'zh' ? '中文' : '对照',
            ),
            React.createElement(
              'button',
              { type: 'button', className: 'dpr-cmpLangBtn', onClick: openGlossary, title: '查看/修改术语表' },
              '术语',
            ),
            React.createElement(
              'button',
              { type: 'button', className: 'dpr-back', onClick: () => onOpenReader(jobId) },
              '打开单篇',
            ),
            React.createElement(
              'button',
              { type: 'button', className: 'dpr-back', onClick: onFocusAnnotation },
              '批注 ' + annotations.filter((item) => item.jobId === jobId).length,
            ),
            translationState?.status === 'running'
              ? React.createElement(
                  'span',
                  { className: 'dpr-cmpTransState' },
                  '翻译中' +
                    (translationState.total
                      ? ' ' + (translationState.done || 0) + '/' + translationState.total
                      : '…'),
                )
              : null,
          ),
        ),
        React.createElement(
          'div',
          { className: 'dpr-cmpPaperBody', ref: bodyRef, onMouseUp },
          error
            ? React.createElement(
                'div',
                { className: 'dpr-error', role: 'alert' },
                React.createElement('span', { 'aria-hidden': true }, '⚠'),
                React.createElement('span', null, '正文没读出来：' + error),
              )
            : null,
          !doc && !error
            ? React.createElement('p', { className: 'dpr-compareHint' }, '正在读取全文…')
            : null,
          abstractText
            ? React.createElement(
                'section',
                { className: 'dpr-cmpAbstractBox' },
                React.createElement('h4', null, langMode === 'zh' ? '摘要' : 'Abstract'),
                React.createElement('p', null, abstractText),
              )
            : null,
          visibleBlocks.map(renderBlock),
        ),
        sel
          ? React.createElement(
              'div',
              { className: 'dpr-cmpSelBar', style: selectionStyle },
              React.createElement(
                'div',
                { className: 'dpr-cmpSelQuote' },
                '「' + sel.quote.slice(0, 90) + (sel.quote.length > 90 ? '…' : '') + '」',
              ),
              React.createElement('textarea', {
                value: draft,
                placeholder: '给这段写个问题（可留空，只标记）…',
                onChange: (event) => setDraft(event.target.value),
                onMouseDown: (event) => event.stopPropagation(),
              }),
              React.createElement(
                'div',
                { className: 'dpr-cmpSelActions' },
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'dpr-cmpLangBtn',
                    disabled: sel.quote.length > 160,
                    title: sel.quote.length > 160 ? '请只选择一个词、缩写或短短语' : '解释当前论文语境',
                    onClick: () => void requestTermLookup(),
                  },
                  '查词',
                ),
                React.createElement(
                  'button',
                  { type: 'button', className: 'dpr-primary', disabled: saving, onClick: saveAnnotation },
                  saving ? '保存中…' : '加入批注',
                ),
                React.createElement(
                  'button',
                  { type: 'button', className: 'dpr-back', onClick: () => setSel(null) },
                  '取消',
                ),
              ),
            )
          : null,
        termLookup
          ? React.createElement(TermLookupCard, {
              state: termLookup,
              onClose: () => setTermLookup(null),
              onRetry: termLookup.request
                ? () => void requestTermLookup(termLookup.request)
                : undefined,
              onLocate: locateTermBlock,
            })
          : null,
        glossaryOpen
          ? React.createElement(GlossaryDialog, {
              entries: glossaryEntries,
              onSave: saveGlossary,
              onClose: () => setGlossaryOpen(false),
              saving: glossarySaving,
              error: glossaryError,
            })
          : null,
      )
    }

    /** 引用蓝链的轻量预览卡；完整概览仍在单篇阅读页。 */
    function CompareCitationCard(props) {
      const { state, onClose, onOpenReader } = props
      if (!state) return null
      const metadata = state.metadata || state.payload?.metadata || {}
      const title =
        metadata.title ||
        state.reference?.title ||
        (state.payload?.kind === 'candidates' ? '多篇候选' : '引用论文')
      const authors = Array.isArray(metadata.authors) ? metadata.authors.join(', ') : metadata.authors || ''
      return React.createElement(
        'aside',
        { className: 'dpr-cmpCitePopover', role: 'dialog', 'aria-label': '引用预览' },
        React.createElement(
          'div',
          { className: 'dpr-cmpCiteHead' },
          React.createElement('span', { className: 'dpr-cmpCiteKicker' }, '引用 [' + (state.number || '?') + ']'),
          React.createElement('button', { type: 'button', className: 'dpr-compareClose', onClick: onClose }, '关闭'),
        ),
        state.status === 'loading'
          ? React.createElement('p', { className: 'dpr-compareHint' }, '正在核对这条引用…')
          : null,
        state.status === 'error'
          ? React.createElement('p', { className: 'dpr-error', role: 'alert' }, state.error || '引用解析失败')
          : null,
        state.status === 'ready'
          ? React.createElement(
              React.Fragment,
              null,
              React.createElement('h3', null, title),
              React.createElement(
                'div',
                { className: 'dpr-compareMeta' },
                [authors, metadata.venue, metadata.year, metadata.doi ? 'DOI ' + metadata.doi : '']
                  .filter(Boolean)
                  .join(' · '),
              ),
              metadata.abstract
                ? React.createElement('p', { className: 'dpr-cmpCiteAbstract' }, metadata.abstract)
                : null,
              state.payload?.analysis?.overview?.summary
                ? React.createElement('p', { className: 'dpr-compareHint' }, state.payload.analysis.overview.summary)
                : null,
              state.message ? React.createElement('p', { className: 'dpr-compareHint' }, state.message) : null,
              React.createElement(
                'div',
                { className: 'dpr-cmpSelActions' },
                state.payload?.kind === 'candidates' && state.citingJobId
                  ? React.createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'dpr-primary',
                        onClick: () => onOpenReader(state.citingJobId, state.citingBlockId),
                      },
                      '去单篇选择',
                    )
                  : null,
                state.jobId
                  ? React.createElement(
                      'button',
                      { type: 'button', className: 'dpr-primary', onClick: () => onOpenReader(state.jobId) },
                      '在精读页打开',
                    )
                  : null,
                React.createElement('button', { type: 'button', className: 'dpr-back', onClick: onClose }, '关闭'),
              ),
            )
          : null,
      )
    }

    /** 产物浮窗：表格 / 论证链 / 文献结构 / 文字汇总。 */
    function CompareArtifactWindow({ artifact, onClose, onOpenBlock, onEditCell, index = 0 }) {
      const { useState, useEffect, useRef } = React
      const [pos, setPos] = useState(null)
      const [editing, setEditing] = useState(false)
      const dragRef = useRef(null)
      useEffect(() => {
        setPos(null)
        setEditing(false)
      }, [artifact?.id])
      if (!artifact) return null
      const payload = artifact.payload || {}
      const table = payload.fields ? payload : null
      const startDrag = (event) => {
        if (event.button !== 0) return
        if (event.target.closest('button')) return
        const win = event.currentTarget.closest('.dpr-cmpArtWindow')
        const parent = win?.parentElement
        if (!win || !parent) return
        const box = win.getBoundingClientRect()
        const parentBox = parent.getBoundingClientRect()
        dragRef.current = {
          dx: event.clientX - box.left,
          dy: event.clientY - box.top,
          x: box.left - parentBox.left,
          y: box.top - parentBox.top,
          width: box.width,
          height: box.height,
        }
        const move = (moveEvent) => {
          const start = dragRef.current
          if (!start) return
          const x = Math.max(4, Math.min(parentBox.width - 120, moveEvent.clientX - parentBox.left - start.dx))
          const y = Math.max(4, Math.min(parentBox.height - 40, moveEvent.clientY - parentBox.top - start.dy))
          setPos({ x, y, width: start.width, height: start.height })
        }
        const up = () => {
          dragRef.current = null
          document.removeEventListener('mousemove', move)
          document.removeEventListener('mouseup', up)
        }
        document.addEventListener('mousemove', move)
        document.addEventListener('mouseup', up)
        event.preventDefault()
      }
      const body = (() => {
        if (artifact.type === 'table') {
          return React.createElement(
            React.Fragment,
            null,
            React.createElement(
              'div',
              { className: 'dpr-cmpArtScroll' },
              React.createElement(
                'table',
                { className: 'dpr-compareTable' },
                React.createElement(
                  'thead',
                  null,
                  React.createElement(
                    'tr',
                    null,
                    React.createElement('th', null, '字段'),
                    (table?.fields?.[0]?.cells || []).map((cell, index) =>
                      React.createElement('th', { key: cell.jobId }, 'P' + (index + 1) + ' ' + cell.title),
                    ),
                  ),
                ),
                React.createElement(
                  'tbody',
                  null,
                  (table?.fields || []).map((field) =>
                    React.createElement(
                      'tr',
                      { key: field.key },
                      React.createElement('th', { title: field.hint }, field.label),
                      field.cells.map((cell) =>
                        React.createElement(
                          'td',
                          {
                            key: cell.jobId + ':' + field.key,
                            className: 'dpr-compareCell' + (cell.grounded ? '' : ' is-ungrounded'),
                          },
                          editing
                            ? React.createElement('textarea', {
                                className: 'dpr-cmpCellEdit',
                                value: cell.text,
                                onChange: (event) =>
                                  onEditCell?.(field.key, cell.jobId, event.target.value),
                              })
                            : React.createElement('p', { className: 'dpr-compareCellText' }, cell.text),
                          cell.blockIds.length > 0
                            ? React.createElement(
                                'div',
                                { className: 'dpr-compareAnchors' },
                                cell.blockIds.map((blockId) =>
                                  React.createElement(
                                    'button',
                                    {
                                      key: blockId,
                                      type: 'button',
                                      className: 'dpr-compareAnchor',
                                      onClick: () => onOpenBlock(cell.jobId, blockId),
                                    },
                                    blockId,
                                  ),
                                ),
                              )
                            : cell.missing
                              ? null
                              : React.createElement('span', { className: 'dpr-compareStats' }, '未定位'),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
            table?.stats
              ? React.createElement(
                  'p',
                  { className: 'dpr-compareStats', style: { padding: '7px 10px' } },
                  '已定位 ' +
                    table.stats.grounded +
                    ' / ' +
                    table.stats.total +
                    (table.warnings?.length ? ' · ' + table.warnings.join('；') : ''),
                )
              : null,
          )
        }
        if (artifact.type === 'concept') {
          const nodes = Array.isArray(payload.nodes) ? payload.nodes : []
          const edges = Array.isArray(payload.edges) ? payload.edges : []
          const columns = Math.max(1, Math.min(3, nodes.length))
          const rows = Math.max(1, Math.ceil(nodes.length / columns))
          const nodeWidth = 238
          const nodeHeight = 132
          const gapX = 38
          const gapY = 34
          const pad = 20
          const width = Math.max(720, columns * nodeWidth + Math.max(0, columns - 1) * gapX + pad * 2)
          const height = Math.max(180, rows * nodeHeight + Math.max(0, rows - 1) * gapY + pad * 2)
          const positions = new Map()
          nodes.forEach((node, nodeIndex) => {
            const column = nodeIndex % columns
            const row = Math.floor(nodeIndex / columns)
            positions.set(node.id, {
              x: pad + column * (nodeWidth + gapX),
              y: pad + row * (nodeHeight + gapY),
            })
          })
          const kindNames = {
            problem: '问题',
            method: '方法',
            evidence: '证据',
            result: '结果',
            gap: '缺口',
            synthesis: '归纳',
          }
          const markerId = 'dpr-cmp-concept-arrow-' + index
          const grounded = nodes.filter((node) => node.grounded)
          return React.createElement(
            'div',
            { className: 'dpr-cmpConcept' },
            payload.summary
              ? React.createElement('p', { className: 'dpr-compareHint' }, payload.summary)
              : null,
            React.createElement(
              'div',
              { className: 'dpr-cmpConceptLegend' },
              React.createElement('span', null, '原文锚点 ' + grounded.length),
              React.createElement('span', null, '模型归纳 ' + Math.max(0, nodes.length - grounded.length)),
              React.createElement('span', null, '关系 ' + edges.length),
              React.createElement('span', null, '虚线节点是跨论文组织，不是论文原话'),
            ),
            React.createElement(
              'div',
              { style: { overflow: 'auto', paddingBottom: '4px' } },
              React.createElement(
                'svg',
                {
                  className: 'dpr-cmpConceptSvg',
                  viewBox: '0 0 ' + width + ' ' + height,
                  role: 'img',
                  'aria-label': payload.title || '论文概念图',
                },
                React.createElement(
                  'defs',
                  null,
                  React.createElement(
                    'marker',
                    {
                      id: markerId,
                      markerWidth: 8,
                      markerHeight: 8,
                      refX: 7,
                      refY: 4,
                      orient: 'auto',
                      markerUnits: 'strokeWidth',
                    },
                    React.createElement('path', {
                      d: 'M0,0 L8,4 L0,8 z',
                      fill: 'currentColor',
                      opacity: 0.55,
                    }),
                  ),
                ),
                edges.map((edge, edgeIndex) => {
                  const from = positions.get(edge.from)
                  const to = positions.get(edge.to)
                  if (!from || !to) return null
                  const x1 = from.x + nodeWidth
                  const y1 = from.y + nodeHeight / 2
                  const x2 = to.x
                  const y2 = to.y + nodeHeight / 2
                  const bend = Math.max(34, Math.abs(x2 - x1) * 0.45)
                  return React.createElement(
                    'path',
                    {
                      key: 'edge' + edgeIndex,
                      className: 'dpr-cmpConceptEdge',
                      d:
                        'M' +
                        x1 +
                        ',' +
                        y1 +
                        ' C' +
                        (x1 + bend) +
                        ',' +
                        y1 +
                        ' ' +
                        (x2 - bend) +
                        ',' +
                        y2 +
                        ' ' +
                        x2 +
                        ',' +
                        y2,
                      markerEnd: 'url(#' + markerId + ')',
                      style: { color: 'var(--dsw-alias-label-tertiary)' },
                    },
                    React.createElement('title', null, edge.label || edge.from + ' → ' + edge.to),
                  )
                }),
                nodes.map((node) => {
                  const position = positions.get(node.id)
                  return React.createElement(
                    'g',
                    { key: node.id },
                    React.createElement(
                      'foreignObject',
                      {
                        x: position.x,
                        y: position.y,
                        width: nodeWidth,
                        height: nodeHeight,
                      },
                      React.createElement(
                        'div',
                        {
                          xmlns: 'http://www.w3.org/1999/xhtml',
                          className:
                            'dpr-cmpConceptNode' +
                            (node.grounded ? ' is-grounded' : ' is-synthesis'),
                        },
                        React.createElement(
                          'span',
                          { className: 'dpr-cmpConceptKind' },
                          (kindNames[node.kind] || '节点') +
                            (node.grounded
                              ? ' · ' + (node.paperTitle || node.jobId || '原文')
                              : ' · 模型归纳'),
                        ),
                        React.createElement('strong', null, node.label),
                        React.createElement('p', null, node.detail || ''),
                      ),
                    ),
                  )
                }),
              ),
            ),
            grounded.length > 0
              ? React.createElement(
                  'div',
                  { className: 'dpr-cmpConceptAnchors' },
                  React.createElement('span', { className: 'dpr-compareStats' }, '原文锚点：'),
                  grounded.map((node) =>
                    React.createElement(
                      'button',
                      {
                        key: node.id,
                        type: 'button',
                        className: 'dpr-compareAnchor',
                        title: node.quote,
                        onClick: () => onOpenBlock(node.jobId, node.blockId),
                      },
                      node.label + ' · ' + node.blockId,
                    ),
                  ),
                )
              : null,
            payload.warnings?.length
              ? React.createElement(
                  'p',
                  { className: 'dpr-compareHint' },
                  payload.warnings.join('；'),
                )
              : null,
          )
        }
        if (artifact.type === 'diagram') {
          return React.createElement(
            'div',
            { className: 'dpr-cmpLogicGrid' },
            (payload.papers || []).map((paper, index) =>
              React.createElement(
                'section',
                { key: paper.jobId, className: 'dpr-cmpLogicCol' },
                React.createElement('h3', null, 'P' + (index + 1) + ' ' + paper.title),
                [
                  ['研究问题', paper.question],
                  ['方法', paper.method],
                  ['主要结果', paper.result],
                  ['局限', paper.limitation],
                ].map(([label, cell], rowIndex) =>
                  React.createElement(
                    React.Fragment,
                    { key: label },
                    rowIndex > 0
                      ? React.createElement('div', { className: 'dpr-cmpLogicArrow', 'aria-hidden': true }, '↓')
                      : null,
                    React.createElement(
                      'div',
                      { className: 'dpr-cmpLogicBox' + (cell?.grounded ? '' : ' is-muted') },
                      React.createElement('span', { className: 'dpr-cmpLogicLabel' }, label),
                      React.createElement('p', null, cell?.text || '未找到'),
                      (cell?.blockIds || []).length > 0
                        ? React.createElement(
                            'div',
                            { className: 'dpr-compareAnchors' },
                            cell.blockIds.map((blockId) =>
                              React.createElement(
                                'button',
                                {
                                  key: blockId,
                                  type: 'button',
                                  className: 'dpr-compareAnchor',
                                  onClick: () => onOpenBlock(paper.jobId, blockId),
                                },
                                blockId,
                              ),
                            ),
                          )
                        : null,
                    ),
                  ),
                ),
              ),
            ),
          )
        }
        if (artifact.type === 'chart') {
          const series = payload.series || []
          if (payload.mode === 'model') {
            const max = Math.max(
              1,
              ...series.flatMap((item) => (item.points || []).map((point) => Math.abs(point.value) || 0)),
            )
            if (payload.type === 'line') {
              const width = 760
              const height = 220
              const pad = 28
              const allPoints = series.flatMap((item) => item.points || [])
              const count = Math.max(2, ...series.map((item) => (item.points || []).length))
              const y = (value) => height - pad - (Math.abs(value) / max) * (height - pad * 2)
              return React.createElement(
                'div',
                { className: 'dpr-cmpModelChart' },
                React.createElement(
                  'p',
                  { className: 'dpr-compareHint' },
                  (payload.unit ? '单位：' + payload.unit + '。' : '') +
                    (payload.note || '每个点只允许引用对照表/档案里已有的数字。'),
                ),
                React.createElement(
                  'svg',
                  {
                    className: 'dpr-cmpLineChart',
                    viewBox: '0 0 ' + width + ' ' + height,
                    role: 'img',
                    'aria-label': payload.title || '模型折线图',
                  },
                  series.map((item, seriesIndex) => {
                    const points = item.points || []
                    const poly = points.map((point, index) => {
                      const x = pad + (index * (width - pad * 2)) / Math.max(1, count - 1)
                      return x + ',' + y(point.value)
                    })
                    return React.createElement(
                      'g',
                      { key: seriesIndex, opacity: 1 - seriesIndex * 0.18 },
                      React.createElement('polyline', {
                        points: poly.join(' '),
                        fill: 'none',
                        stroke: 'currentColor',
                        strokeWidth: 2.5,
                      }),
                      points.map((point, index) =>
                        React.createElement('circle', {
                          key: index,
                          cx: pad + (index * (width - pad * 2)) / Math.max(1, count - 1),
                          cy: y(point.value),
                          r: 3.5,
                          fill: 'currentColor',
                        }),
                      ),
                    )
                  }),
                ),
                React.createElement(
                  'div',
                  { className: 'dpr-cmpLineLegend' },
                  series.map((item, index) =>
                    React.createElement('span', { key: index }, '● ' + (item.label || '系列 ' + (index + 1))),
                  ),
                ),
                React.createElement(
                  'div',
                  { className: 'dpr-cmpAnchors' },
                  allPoints.map((point, index) =>
                    React.createElement(
                      'button',
                      {
                        key: index,
                        type: 'button',
                        className: 'dpr-compareAnchor',
                        title: point.quote,
                        onClick: () => onOpenBlock(point.jobId, point.blockId),
                      },
                      point.label + ' ' + point.value + ' · ' + point.blockId,
                    ),
                  ),
                ),
                payload.warnings?.length
                  ? React.createElement('p', { className: 'dpr-compareHint' }, payload.warnings.join('；'))
                  : null,
              )
            }
            return React.createElement(
              'div',
              { className: 'dpr-cmpModelChart' },
              React.createElement(
                'p',
                { className: 'dpr-compareHint' },
                (payload.unit ? '单位：' + payload.unit + '。' : '') +
                  (payload.note || '每个点只允许引用对照表/档案里已有的数字。'),
              ),
              series.map((item, seriesIndex) =>
                React.createElement(
                  'section',
                  { key: seriesIndex, className: 'dpr-cmpChartCard' },
                  React.createElement('h3', null, item.label || '系列 ' + (seriesIndex + 1)),
                  (item.points || []).map((point, pointIndex) =>
                    React.createElement(
                      'div',
                      { key: pointIndex, className: 'dpr-cmpChartRow' },
                      React.createElement('span', { className: 'dpr-cmpChartLabel' }, point.label),
                      React.createElement(
                        'span',
                        { className: 'dpr-cmpChartTrack' },
                        React.createElement('span', {
                          className: 'dpr-cmpChartFill',
                          style: {
                            width:
                              (point.value
                                ? Math.max(2, Math.round((Math.abs(point.value) / max) * 100))
                                : 0) + '%',
                          },
                        }),
                      ),
                      React.createElement(
                        'span',
                        { className: 'dpr-cmpChartValue' },
                        String(point.value),
                      ),
                      React.createElement(
                        'button',
                        {
                          type: 'button',
                          className: 'dpr-compareAnchor',
                          title: point.quote,
                          onClick: () => onOpenBlock(point.jobId, point.blockId),
                        },
                        point.blockId,
                      ),
                    ),
                  ),
                ),
              ),
              payload.warnings?.length
                ? React.createElement('p', { className: 'dpr-compareHint' }, payload.warnings.join('；'))
                : null,
            )
          }
          if (payload.mode === 'coverage') {
            const max = Math.max(
              1,
              ...series.map((item) => item.total || (item.grounded || 0) + (item.missing || 0) + (item.ungrounded || 0)),
            )
            const bar = (label, value) =>
              React.createElement(
                'div',
                { className: 'dpr-cmpChartRow' },
                React.createElement('span', { className: 'dpr-cmpChartLabel' }, label),
                React.createElement(
                  'span',
                  { className: 'dpr-cmpChartTrack' },
                  React.createElement('span', {
                    className: 'dpr-cmpChartFill',
                    style: {
                      width: (value ? Math.max(2, Math.round(((value || 0) / max) * 100)) : 0) + '%',
                    },
                  }),
                ),
                React.createElement('span', { className: 'dpr-cmpChartValue' }, String(value || 0)),
              )
            return React.createElement(
              'div',
              { className: 'dpr-cmpChartList' },
              series.map((item, index) =>
                React.createElement(
                  'section',
                  { key: item.jobId, className: 'dpr-cmpChartCard' },
                  React.createElement('h3', null, 'P' + (index + 1) + ' ' + item.title),
                  bar('已定位', item.grounded),
                  bar('未找到', item.missing),
                  bar('未定位', item.ungrounded),
                ),
              ),
              React.createElement(
                'p',
                { className: 'dpr-compareHint' },
                '覆盖度来自七字段表的真实定位状态；未定位的单元格仍需回原文核对。',
              ),
            )
          }
          const max = Math.max(
            1,
            ...series.flatMap((item) => [item.figures || 0, item.tables || 0, item.references || 0]),
          )
          const bar = (label, value) =>
            React.createElement(
              'div',
              { className: 'dpr-cmpChartRow' },
              React.createElement('span', { className: 'dpr-cmpChartLabel' }, label),
              React.createElement(
                'span',
                { className: 'dpr-cmpChartTrack' },
                React.createElement('span', {
                  className: 'dpr-cmpChartFill',
                  style: {
                    width: (value ? Math.max(2, Math.round(((value || 0) / max) * 100)) : 0) + '%',
                  },
                }),
              ),
              React.createElement('span', { className: 'dpr-cmpChartValue' }, String(value || 0)),
            )
          return React.createElement(
            'div',
            { className: 'dpr-cmpChartList' },
            series.map((item, index) =>
              React.createElement(
                'section',
                { key: item.jobId, className: 'dpr-cmpChartCard' },
                React.createElement('h3', null, 'P' + (index + 1) + ' ' + item.title),
                bar('图', item.figures),
                bar('表', item.tables),
                bar('参考文献', item.references),
              ),
            ),
            React.createElement('p', { className: 'dpr-compareHint' }, '计数来自各篇 MirrorDoc 的确定性统计，不是模型估计。'),
          )
        }
        if (artifact.type === 'version') {
          const column = (title, items, sideJobId, side) =>
            React.createElement(
              'section',
              { className: 'dpr-cmpVersionCol' },
              React.createElement('h3', null, title + '（' + (items?.length || 0) + '）'),
              React.createElement(
                'div',
                { className: 'dpr-cmpVersionSide' },
                React.createElement(
                  'strong',
                  null,
                  (side?.version?.label || '版本未核验') + ' · ' + (side?.title || '未命名论文'),
                ),
                React.createElement('span', null, 'jobId ' + (side?.jobId || '未知')),
              ),
              (items || []).length === 0
                ? React.createElement('p', { className: 'dpr-compareHint' }, '无')
                : (items || []).map((item) =>
                    React.createElement(
                      'div',
                      { key: item.blockId, className: 'dpr-cmpVersionItem' },
                      React.createElement(
                        'div',
                        { className: 'dpr-compareStats' },
                        'p.' + (item.page || '?') + ' · ' + (item.section || '正文') + ' · ' + item.blockId,
                      ),
                      React.createElement('p', null, item.text),
                      React.createElement(
                        'button',
                        {
                          type: 'button',
                          className: 'dpr-compareAnchor',
                          onClick: () => onOpenBlock(sideJobId || payload.right?.jobId || payload.left?.jobId, item.blockId),
                        },
                        '定位',
                      ),
                    ),
                  ),
            )
          return React.createElement(
            'div',
            { className: 'dpr-cmpVersionGrid' },
            column('右侧独有（新增/改动）', payload.added, payload.right?.jobId, payload.right),
            column('左侧独有（删除/改写）', payload.removed, payload.left?.jobId, payload.left),
            React.createElement(
              'p',
              { className: 'dpr-compareHint' },
              '相同段落 ' +
                (payload.unchanged || 0) +
                ' 段；' +
                (payload.left?.version?.label || '左版本') +
                ' ↔ ' +
                (payload.right?.version?.label || '右版本') +
                '。按段落级 LCS 确定性比较；文本不完全相同的段落会同时出现在两侧，需人工判断是新增、删除还是改写。',
            ),
          )
        }
        return React.createElement('pre', { className: 'dpr-cmpArtText' }, payload.text || '')
      })()
      const markdown =
        artifact.type === 'table'
          ? tableToMarkdown(payload)
          : artifact.type === 'summary'
            ? String(payload.text || '')
            : ''
      const copyMarkdown = () => {
        try {
          void navigator.clipboard?.writeText(markdown)
        } catch {
          // 剪贴板不可用时仍可下载。
        }
      }
      return React.createElement(
        'section',
        {
          className: 'dpr-cmpArtWindow',
          role: 'dialog',
          'aria-label': artifact.title,
          style: pos
            ? { left: pos.x, top: pos.y, width: pos.width, height: pos.height, right: 'auto', bottom: 'auto' }
            : {
                left: 12 + index * 22,
                top: 64 + index * 22,
                right: 'auto',
                bottom: 'auto',
                width: 'min(920px, calc(100% - 40px))',
                height: 'min(760px, calc(100% - 92px))',
              },
        },
        React.createElement(
          'header',
          { className: 'dpr-cmpArtHead', onMouseDown: startDrag, title: '拖动浮窗' },
          React.createElement('span', { className: 'dpr-cmpArtIcon' }, artifactIcon(artifact.type)),
          React.createElement('h3', null, artifact.title),
          markdown
            ? React.createElement(
                'div',
                { className: 'dpr-cmpArtActions' },
                artifact.type === 'table'
                  ? React.createElement(
                      'button',
                      { type: 'button', className: 'dpr-back', onClick: () => setEditing((value) => !value) },
                      editing ? '完成' : '编辑',
                    )
                  : null,
                React.createElement('button', { type: 'button', className: 'dpr-back', onClick: copyMarkdown }, '复制 Markdown'),
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'dpr-back',
                    onClick: () =>
                      downloadTextFile(
                        artifact.type === 'table' ? 'compare-table.md' : 'compare-summary.md',
                        markdown,
                      ),
                  },
                  '下载 .md',
                ),
              )
            : null,
          React.createElement('button', { type: 'button', className: 'dpr-compareClose', onClick: onClose }, '关闭'),
        ),
        React.createElement('div', { className: 'dpr-cmpArtBody' }, body),
      )
    }

    /** 右侧「小凸起」：产物数量按钮 + 小列表。 */
    function CompareArtifactRail({ state, onToggle, onOpen }) {
      const count = state.artifacts.length
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          'div',
          { className: 'dpr-cmpRail' },
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dpr-cmpRailBtn' + (state.artListOpen ? ' is-open' : ''),
              onClick: onToggle,
              title: '产物列表',
            },
            React.createElement('span', { 'aria-hidden': true }, '▣'),
            React.createElement('span', { className: 'dpr-cmpRailLabel' }, '产物'),
            React.createElement('span', { className: 'dpr-cmpRailCount' }, String(count)),
          ),
        ),
        state.artListOpen
          ? React.createElement(
              'div',
              { className: 'dpr-cmpArtList', role: 'menu' },
              React.createElement('div', { className: 'dpr-cmpArtListHead' }, '产物'),
              count === 0
                ? React.createElement('p', { className: 'dpr-compareHint' }, '还没有产物；先生成对照表或逻辑图。')
                : state.artifacts.map((artifact) =>
                    React.createElement(
                      'button',
                      {
                        key: artifact.id,
                        type: 'button',
                        className:
                          'dpr-cmpArtItem' +
                          ((state.openArtifacts || []).includes(artifact.id) ? ' is-active' : ''),
                        onClick: () => onOpen(artifact.id),
                      },
                      React.createElement('span', { className: 'dpr-cmpArtIcon' }, artifactIcon(artifact.type)),
                      React.createElement('span', null, artifact.title),
                    ),
                  ),
            )
          : null,
      )
    }

    /** 右侧工作台：对话 + 批注 + 命令 + 产物入口。 */
    function CompareWorkspace(props) {
      const { useState } = React
      const { state, digests, annotations, onAsk, onCommand, onFocusBlock, onOpenReader, onClear, onTab } = props
      const [draft, setDraft] = useState('')
      const messages = Array.isArray(state.messages) ? state.messages : []
      const pending = annotations.filter((item) => state.jobIds.includes(item.jobId))
      const submit = () => {
        const text = draft.trim()
        if (!text || state.chatState === 'running') return
        setDraft('')
        onAsk(text)
      }
      return React.createElement(
        'aside',
        { className: 'dpr-cmpWorkspace' },
        React.createElement(
          'header',
          { className: 'dpr-cmpWorkspaceHead' },
          React.createElement(
            'div',
            null,
            React.createElement('span', { className: 'dpr-compareKicker' }, '对照工作台'),
            React.createElement(
              'h3',
              null,
              state.mode === 'citation'
                ? '引用关系'
                : state.mode === 'version'
                  ? '版本差异'
                  : '多篇综合',
            ),
          ),
          React.createElement(
            'div',
            { className: 'dpr-cmpWorkspaceMeta' },
            digests.length + ' 篇 · ' + pending.filter((item) => !item.sent).length + ' 条待发批注',
          ),
        ),
        React.createElement(
          'div',
          { className: 'dpr-cmpTabs', role: 'tablist' },
          React.createElement(
            'button',
            {
              type: 'button',
              role: 'tab',
              className: state.tab === 'chat' ? 'is-active' : '',
              onClick: () => onTab('chat'),
            },
            '对话',
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              role: 'tab',
              className: state.tab === 'notes' ? 'is-active' : '',
              onClick: () => onTab('notes'),
            },
            '批注 ' + pending.length,
          ),
        ),
        state.tab === 'notes'
          ? React.createElement(
              'div',
              { className: 'dpr-cmpNotes' },
              pending.length === 0
                ? React.createElement('p', { className: 'dpr-compareHint' }, '两篇论文还没有批注。左侧选中文字即可加入。')
                : pending.map((item) => {
                    const segment = item.segments?.[0] || {}
                    return React.createElement(
                      'div',
                      { key: item.id, className: 'dpr-cmpNoteItem' },
                      React.createElement(
                        'div',
                        { className: 'dpr-cmpNoteMeta' },
                        '《' + (item.context?.paper?.title || item.jobId) + '》 · p.' + (segment.page || '?') + ' · ' + (segment.section || '正文'),
                      ),
                      React.createElement('p', { className: 'dpr-cmpNoteQuestion' }, item.question || '（只标记，未写问题）'),
                      React.createElement('p', { className: 'dpr-cmpNoteQuote' }, '「' + (segment.quote || '').slice(0, 140) + '」'),
                      React.createElement(
                        'div',
                        { className: 'dpr-cmpNoteActions' },
                        React.createElement(
                          'button',
                          {
                            type: 'button',
                            className: 'dpr-back',
                            onClick: () => onFocusBlock(item.jobId, segment.blockId),
                          },
                          '定位',
                        ),
                        React.createElement(
                          'button',
                          { type: 'button', className: 'dpr-back', onClick: () => annotationStore.remove(item.id) },
                          '删除',
                        ),
                      ),
                    )
                  }),
            )
          : React.createElement(
              React.Fragment,
              null,
              React.createElement(
                'div',
                { className: 'dpr-cmpChatList' },
                messages.length === 0
                  ? React.createElement(
                      'div',
                      { className: 'dpr-cmpChatEmpty' },
                      React.createElement('p', null, '直接问这两篇论文；批注会跟随下一条问题一起发送。'),
                      React.createElement('p', { className: 'dpr-compareHint' }, '也可以点下面的命令生成表格、概念图或有原文出处的数据图。'),
                    )
                  : messages.map((message, index) =>
                      React.createElement(
                        'div',
                        {
                          key: index,
                          className: 'dpr-cmpMsg' + (message.role === 'user' ? ' is-user' : ' is-assistant'),
                        },
                        React.createElement('div', { className: 'dpr-cmpMsgRole' }, message.role === 'user' ? '陛下' : '大肥鱼'),
                        React.createElement(
                          'div',
                          { className: 'dpr-cmpMsgBody' },
                          message.role === 'user' ? message.content : renderMarkdown(message.content),
                        ),
                      ),
                    ),
              ),
              state.chatError
                ? React.createElement('div', { className: 'dpr-error', role: 'alert' }, state.chatError)
                : null,
              React.createElement(
                'div',
                { className: 'dpr-cmpCommands' },
                React.createElement('button', { type: 'button', onClick: () => onCommand('table') }, '生成对照表'),
                React.createElement('button', { type: 'button', onClick: () => onCommand('logic') }, '论证链'),
                React.createElement('button', { type: 'button', onClick: () => onCommand('concept') }, '概念图'),
                React.createElement('button', { type: 'button', onClick: () => onCommand('structure') }, '结构统计'),
                React.createElement('button', { type: 'button', onClick: () => onCommand('coverage') }, '证据覆盖'),
                React.createElement('button', { type: 'button', onClick: () => onCommand('model-chart') }, '数据图'),
                React.createElement('button', { type: 'button', onClick: () => onCommand('summary') }, '汇总'),
                React.createElement('button', { type: 'button', onClick: () => onCommand('report') }, '导出报告'),
                React.createElement('button', { type: 'button', onClick: () => onCommand('archive') }, '归档'),
                state.mode === 'version'
                  ? React.createElement(
                      'button',
                      { type: 'button', onClick: () => onCommand('version') },
                      '版本差异',
                    )
                  : null,
                state.mode === 'survey'
                  ? React.createElement(
                      'button',
                      { type: 'button', onClick: () => onCommand('simulate-citation') },
                      '模拟引用（调试）',
                    )
                  : null,
                state.mode === 'citation'
                  ? React.createElement('button', { type: 'button', onClick: () => onCommand('citation') }, '引用判断')
                  : null,
              ),
              React.createElement(
                'div',
                { className: 'dpr-cmpComposer' },
                React.createElement('textarea', {
                  value: draft,
                  placeholder: '问这两篇论文，或输入「生成表格」「画概念图」…',
                  onChange: (event) => setDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      submit()
                    }
                  },
                }),
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'dpr-primary',
                    disabled: state.chatState === 'running' || !draft.trim(),
                    onClick: submit,
                  },
                  state.chatState === 'running' ? '思考中…' : '发送',
                ),
              ),
              React.createElement(
                'div',
                { className: 'dpr-cmpWorkspaceFoot' },
                React.createElement('button', { type: 'button', className: 'dpr-back', onClick: onClear }, '清空对话'),
                React.createElement('button', { type: 'button', className: 'dpr-back', onClick: () => onOpenReader(state.jobIds[0]) }, '打开单篇'),
              ),
            ),
      )
    }

    function LegacyCompareOverlay(props) {
      const { useState, useEffect } = React
      const t = props.t
      const state = useComparison()
      const [question, setQuestion] = useState('')
      const [busy, setBusy] = useState('')
      const [localError, setLocalError] = useState('')
      const [notice, setNotice] = useState('')

      const runId = state.runId
      // 同一个插件里的其它入口（以及自动化走查）可以用这个前缀事件打开对照视图；
      // 只接受 2–3 个合法 jobId，避免把任意 detail 拼进宿主导航。
      useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const onCompare = (event) => {
          const detail = event?.detail || {}
          const jobIds = Array.isArray(detail.jobIds)
            ? [...new Set(detail.jobIds.map(String).filter((id) => JOB_ID_RE.test(id)))]
            : []
          if (jobIds.length < 2 || jobIds.length > 3) return
          comparisonStore.open({
            mode: detail.mode === 'citation' ? 'citation' : 'survey',
            jobIds,
            citing:
              detail.citing && JOB_ID_RE.test(String(detail.citing.jobId || ''))
                ? detail.citing
                : null,
          })
        }
        window.addEventListener('doraemon-paper-reader:compare', onCompare)
        return () => window.removeEventListener('doraemon-paper-reader:compare', onCompare)
      }, [])

      useEffect(() => {
        if (!state.open || state.digests.length > 0 || state.digestState !== 'loading') return undefined
        let alive = true
        postApi('compare/digests', {
          jobIds: state.jobIds,
          ...(state.mode === 'citation' && state.citing ? { citing: state.citing } : {}),
        })
          .then((payload) => {
            if (!alive || comparisonStore.getSnapshot().runId !== runId) return
            comparisonStore.patch({
              digests: Array.isArray(payload.digests) ? payload.digests : [],
              citing: payload.citing || state.citing,
              digestState: 'done',
            })
          })
          .catch((cause) => {
            if (!alive || comparisonStore.getSnapshot().runId !== runId) return
            comparisonStore.patch({ digestState: 'error', error: cause?.message || String(cause) })
          })
        return () => {
          alive = false
        }
      }, [state.open, state.digestState, state.digests.length, runId, state.mode])

      useEffect(() => {
        if (!state.open) return
        for (const jobId of state.jobIds) void annotationStore.loadForJob(jobId)
      }, [state.open, state.jobIds.join(',')])

      useEffect(() => {
        if (!state.open) {
          setBusy('')
          setLocalError('')
          setNotice('')
          setQuestion('')
        }
      }, [state.open])

      useEffect(() => {
        if (!state.open || typeof window === 'undefined') return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          if (document.querySelector('.dpr-citeOverlay')) return
          if (citeCard) {
            setCiteCard(null)
            return
          }
          const current = comparisonStore.getSnapshot()
          if (current.openArtifacts?.length) {
            comparisonStore.closeArtifact(current.openArtifacts[current.openArtifacts.length - 1])
            return
          }
          comparisonStore.close()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [state.open, citeCard])

      if (!state.open) return null

      const openAt = (jobId, blockId) => {
        comparisonStore.close()
        props.openReader(jobId, blockId)
      }
      const reload = () => {
        comparisonStore.patch({ digests: [], digestState: 'loading', error: '' })
      }
      const buildTable = async () => {
        if (busy) return
        setBusy('table')
        setLocalError('')
        try {
          const payload = await postApi('compare/table', { jobIds: state.jobIds })
          if (comparisonStore.getSnapshot().runId !== runId) return
          comparisonStore.patch({
            table: applyTableEdits(payload.table || null, state.tableEdits),
            tableState: 'done',
            digests: Array.isArray(payload.digests) ? payload.digests : state.digests,
          })
        } catch (cause) {
          if (comparisonStore.getSnapshot().runId === runId) setLocalError(cause?.message || String(cause))
        } finally {
          setBusy('')
        }
      }
      const judgeCitation = async () => {
        if (busy || !state.citing?.jobId || !state.citing?.blockId) return
        const cited = state.jobIds.find((id) => id !== state.citing.jobId)
        if (!cited) return
        setBusy('citation')
        setLocalError('')
        try {
          const payload = await postApi('compare/citation', {
            citingJobId: state.citing.jobId,
            citedJobId: cited,
            blockId: state.citing.blockId,
            number: state.citing.number || 0,
            title: state.citing.title || '',
          })
          if (comparisonStore.getSnapshot().runId !== runId) return
          comparisonStore.patch({
            citation: payload.analysis || null,
            citing: payload.citing || state.citing,
            citationState: 'done',
            digests: Array.isArray(payload.digests) ? payload.digests : state.digests,
          })
        } catch (cause) {
          if (comparisonStore.getSnapshot().runId === runId) setLocalError(cause?.message || String(cause))
        } finally {
          setBusy('')
        }
      }
      const askTogether = async () => {
        if (busy) return
        setBusy('ask')
        setLocalError('')
        setNotice('')
        const pendingAnnotations = annotationStore
          .getSnapshot()
          .filter((item) => !item.sent && state.jobIds.includes(item.jobId))
        try {
          const payload = await postApi('compare/packet', {
            jobIds: state.jobIds,
            mode: state.mode,
            question,
            ...(state.mode === 'citation' && state.citing ? { citing: state.citing } : {}),
            ...(pendingAnnotations.length > 0
              ? {
                  annotations: pendingAnnotations.map((item) => ({
                    jobId: item.jobId,
                    question: item.question,
                    context: item.context,
                    segments: item.segments,
                  })),
                }
              : {}),
          })
          await props.submitDraft(payload.message)
          if (pendingAnnotations.length > 0) {
            annotationStore.markSent(pendingAnnotations.map((item) => item.id))
          }
          setNotice(
            t('compare.sent') +
              (pendingAnnotations.length > 0 ? '（含 ' + pendingAnnotations.length + ' 条批注）' : ''),
          )
        } catch (cause) {
          setLocalError(cause?.message || String(cause))
        } finally {
          setBusy('')
        }
      }
      const verdictClass =
        state.citation?.verdict === 'supports'
          ? 'is-supports'
          : state.citation?.verdict === 'conflicts'
            ? 'is-conflicts'
            : state.citation?.verdict === 'insufficient'
              ? 'is-insufficient'
              : ''

      const paperCard = (digest, index) =>
        React.createElement(
          'article',
          { key: digest.jobId, className: 'dpr-comparePaper' },
          React.createElement('h3', null, 'P' + (index + 1) + ' · ' + digest.title),
          React.createElement(
            'div',
            { className: 'dpr-compareMeta' },
            [
              digest.authors,
              digest.year ? String(digest.year) : '',
              digest.doi ? 'DOI ' + digest.doi : '',
              digest.arxiv ? 'arXiv ' + digest.arxiv : '',
            ]
              .filter(Boolean)
              .join(' · '),
          ),
          digest.abstract
            ? React.createElement('p', { className: 'dpr-compareAbstract' }, digest.abstract)
            : null,
          digest.sections.length > 0
            ? React.createElement(
                React.Fragment,
                null,
                React.createElement('div', { className: 'dpr-compareMeta' }, t('compare.sections')),
                React.createElement(
                  'div',
                  { className: 'dpr-compareSections' },
                  digest.sections.map((section, sectionIndex) =>
                    React.createElement(
                      'button',
                      {
                        key: digest.jobId + ':' + sectionIndex,
                        type: 'button',
                        className: 'dpr-compareChip',
                        title: section.gist || section.title,
                        onClick: () => openAt(digest.jobId, section.blockId),
                      },
                      section.title,
                    ),
                  ),
                ),
              )
            : null,
          React.createElement(
            'div',
            { className: 'dpr-compareMeta' },
            t('compare.counts') +
              '：图 ' +
              digest.counts.figures +
              ' · 表 ' +
              digest.counts.tables +
              ' · 公式 ' +
              digest.counts.equations +
              ' · 参考文献 ' +
              digest.counts.references,
          ),
          React.createElement(
            'div',
            { className: 'dpr-compareActions' },
            React.createElement(
              'button',
              { type: 'button', className: 'dpr-back', onClick: () => openAt(digest.jobId, '') },
              t('compare.openReader'),
            ),
          ),
        )

      const table =
        state.mode === 'survey'
          ? React.createElement(
              'section',
              { className: 'dpr-compareTableWrap' },
              React.createElement(
                'div',
                { className: 'dpr-compareBlockTitle' },
                React.createElement('h3', null, t('compare.table')),
                React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'dpr-back',
                    disabled: Boolean(busy) || state.digestState !== 'done',
                    onClick: buildTable,
                  },
                  busy === 'table' ? t('compare.regenerating') : state.table ? '重新生成' : t('compare.generate'),
                ),
              ),
              state.table
                ? React.createElement(
                    React.Fragment,
                    null,
                    React.createElement(
                      'table',
                      { className: 'dpr-compareTable' },
                      React.createElement(
                        'thead',
                        null,
                        React.createElement(
                          'tr',
                          null,
                          React.createElement('th', null, '字段'),
                          state.digests.map((digest, index) =>
                            React.createElement('th', { key: digest.jobId }, 'P' + (index + 1) + ' ' + digest.title),
                          ),
                        ),
                      ),
                      React.createElement(
                        'tbody',
                        null,
                        state.table.fields.map((field) =>
                          React.createElement(
                            'tr',
                            { key: field.key },
                            React.createElement('th', { title: field.hint }, field.label),
                            field.cells.map((cell) =>
                              React.createElement(
                                'td',
                                {
                                  key: cell.jobId + ':' + field.key,
                                  className: 'dpr-compareCell' + (cell.grounded ? '' : ' is-ungrounded'),
                                },
                                React.createElement('p', { className: 'dpr-compareCellText' }, cell.text),
                                cell.blockIds.length > 0
                                  ? React.createElement(
                                      'div',
                                      { className: 'dpr-compareAnchors' },
                                      cell.blockIds.map((blockId) =>
                                        React.createElement(
                                          'button',
                                          {
                                            key: blockId,
                                            type: 'button',
                                            className: 'dpr-compareAnchor',
                                            onClick: () => openAt(cell.jobId, blockId),
                                          },
                                          blockId,
                                        ),
                                      ),
                                    )
                                  : cell.missing
                                    ? null
                                    : React.createElement(
                                        'span',
                                        { className: 'dpr-compareStats' },
                                        t('compare.ungrounded'),
                                      ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                    React.createElement(
                      'div',
                      { className: 'dpr-compareStats', style: { padding: '7px 9px' } },
                      t('compare.stats') +
                        state.table.stats.grounded +
                        ' / ' +
                        state.table.stats.total +
                        (state.table.warnings?.length ? ' · ' + state.table.warnings.join('；') : ''),
                    ),
                  )
                : React.createElement(
                    'p',
                    { className: 'dpr-compareHint', style: { padding: '9px 10px' } },
                    busy === 'table' ? t('compare.regenerating') : t('compare.tableEmpty'),
                  ),
            )
          : null

      const citation =
        state.mode === 'citation'
          ? React.createElement(
              React.Fragment,
              null,
              React.createElement(
                'section',
                { className: 'dpr-comparePaper' },
                React.createElement('h3', null, t('compare.citing') + ' · [' + (state.citing?.number || '?') + ']'),
                React.createElement(
                  'div',
                  { className: 'dpr-compareMeta' },
                  state.citing?.title || '',
                ),
                React.createElement('p', { className: 'dpr-citeQuote' }, state.citing?.text || '正在读取引用处原文…'),
                React.createElement(
                  'div',
                  { className: 'dpr-compareActions' },
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'dpr-back',
                      onClick: () => openAt(state.citing.jobId, state.citing.blockId),
                    },
                    t('compare.backCite'),
                  ),
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'dpr-primary',
                      disabled: Boolean(busy) || state.digestState !== 'done',
                      onClick: judgeCitation,
                    },
                    busy === 'citation' ? t('compare.judging') : t('compare.judge'),
                  ),
                ),
              ),
              state.citation
                ? React.createElement(
                    'section',
                    { className: 'dpr-compareVerdict' },
                    React.createElement(
                      'span',
                      { className: 'dpr-compareVerdictLabel ' + verdictClass },
                      t('compare.verdict') + '：' + state.citation.label,
                    ),
                    state.citation.claim
                      ? React.createElement(
                          'p',
                          { className: 'dpr-compareCellText' },
                          'A 的主张：' + state.citation.claim,
                        )
                      : null,
                    state.citation.citedContribution
                      ? React.createElement(
                          'p',
                          { className: 'dpr-compareCellText' },
                          'B 的实际内容：' + state.citation.citedContribution,
                        )
                      : null,
                    state.citation.gap
                      ? React.createElement('p', { className: 'dpr-compareCellText' }, '缺口：' + state.citation.gap)
                      : null,
                    state.citation.nextSection
                      ? React.createElement(
                          'p',
                          { className: 'dpr-compareHint' },
                          '建议核对：' + state.citation.nextSection,
                        )
                      : null,
                    state.citation.evidence.length > 0
                      ? React.createElement(
                          'div',
                          { className: 'dpr-compareAnchors' },
                          state.citation.evidence.map((item) =>
                            React.createElement(
                              'button',
                              {
                                key: item.jobId + ':' + item.blockId,
                                type: 'button',
                                className: 'dpr-compareAnchor',
                                title: item.quote,
                                onClick: () => openAt(item.jobId, item.blockId),
                              },
                              t('compare.evidence') +
                                ' ' +
                                item.blockId +
                                (item.page ? ' · p.' + item.page : ''),
                            ),
                          ),
                        )
                      : null,
                    state.citation.warnings?.length
                      ? React.createElement(
                          'p',
                          { className: 'dpr-compareHint' },
                          state.citation.warnings.join('；'),
                        )
                      : null,
                  )
                : null,
            )
          : null

      return React.createElement(
        'div',
        { className: 'dpr-compareRoot' },
        React.createElement('div', {
          className: 'dpr-compareBackdrop',
          onClick: () => comparisonStore.close(),
        }),
        React.createElement(
          'div',
          { className: 'dpr-comparePanel', role: 'dialog', 'aria-modal': true, 'aria-label': t('compare.surveyTitle') },
          React.createElement(
            'header',
            { className: 'dpr-compareHeader' },
            React.createElement(
              'div',
              null,
              React.createElement(
                'span',
                { className: 'dpr-compareKicker' },
                state.mode === 'citation'
                  ? t('compare.citationTitle')
                  : state.mode === 'version'
                    ? '版本对照'
                    : t('compare.surveyTitle'),
              ),
              React.createElement(
                'h2',
                { className: 'dpr-compareTitle' },
                state.digests.length > 0
                  ? state.digests.map((digest) => '《' + digest.title + '》').join(' × ')
                  : t('compare.loading'),
              ),
            ),
            React.createElement(
              'button',
              { type: 'button', className: 'dpr-compareClose', onClick: () => comparisonStore.close() },
              t('compare.close'),
            ),
          ),
          React.createElement(
            'div',
            { className: 'dpr-compareBody' },
            React.createElement(
              'main',
              { className: 'dpr-compareMain' },
              state.digestState === 'error'
                ? React.createElement(
                    'div',
                    { className: 'dpr-error', role: 'alert' },
                    React.createElement('span', { 'aria-hidden': true }, '⚠'),
                    React.createElement('span', null, t('compare.loadFailed') + (state.error || '')),
                    React.createElement('button', { type: 'button', onClick: reload }, '重试'),
                  )
                : null,
              state.digestState === 'loading' && state.digests.length === 0
                ? React.createElement('p', { className: 'dpr-compareHint' }, t('compare.loading'))
                : null,
              state.digests.length > 0
                ? React.createElement('div', { className: 'dpr-comparePapers' }, state.digests.map(paperCard))
                : null,
              table,
              citation,
            ),
            React.createElement(
              'aside',
              { className: 'dpr-compareSide' },
              React.createElement('h3', { className: 'dpr-compareBlockTitle' }, t('compare.ask')),
              React.createElement('textarea', {
                className: 'dpr-compareAsk',
                value: question,
                placeholder: t('compare.askPlaceholder'),
                onChange: (event) => setQuestion(event.target.value),
              }),
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dpr-primary',
                  disabled: Boolean(busy) || state.digestState !== 'done',
                  onClick: askTogether,
                },
                busy === 'ask' ? t('compare.sending') : t('compare.askSend'),
              ),
              React.createElement('p', { className: 'dpr-compareHint' }, t('compare.toolHint')),
              notice ? React.createElement('p', { className: 'dpr-compareStats' }, notice) : null,
              localError
                ? React.createElement(
                    'div',
                    { className: 'dpr-error', role: 'alert' },
                    React.createElement('span', { 'aria-hidden': true }, '⚠'),
                    React.createElement('span', null, localError),
                  )
                : null,
              React.createElement(
                'button',
                { type: 'button', className: 'dpr-back', onClick: () => comparisonStore.close() },
                t('compare.close'),
              ),
            ),
          ),
        ),
      )
    }

    /**
     * 对照工作台 v2：左侧两篇全文阅读，右侧工作台，表格/图表/逻辑图走浮窗。
     * 旧版 LegacyCompareOverlay 只保留作迁移参照，不再注册。
     */
    function CompareOverlay(props) {
      const { useState, useEffect } = React
      const t = props.t
      const state = useComparison()
      const annotations = useAnnotations()
      const [busy, setBusy] = useState('')
      const [localError, setLocalError] = useState('')
      const [notice, setNotice] = useState('')
      const [citeCard, setCiteCard] = useState(null)
      const runId = state.runId

      // 插件内部与 L2 走查用的前缀事件；只接受 2–3 个合法 jobId。
      useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const onCompare = (event) => {
          const detail = event?.detail || {}
          const jobIds = Array.isArray(detail.jobIds)
            ? [...new Set(detail.jobIds.map(String).filter((id) => JOB_ID_RE.test(id)))]
            : []
          if (jobIds.length < 2 || jobIds.length > 3) return
          comparisonStore.open({
            mode: detail.mode === 'citation' ? 'citation' : 'survey',
            jobIds,
            citing:
              detail.citing && JOB_ID_RE.test(String(detail.citing.jobId || ''))
                ? detail.citing
                : null,
          })
        }
        window.addEventListener('doraemon-paper-reader:compare', onCompare)
        return () => window.removeEventListener('doraemon-paper-reader:compare', onCompare)
      }, [])

      useEffect(() => {
        if (!state.open || state.digests.length > 0 || state.digestState !== 'loading') return undefined
        let alive = true
        postApi('compare/digests', {
          jobIds: state.jobIds,
          ...(state.mode === 'citation' && state.citing ? { citing: state.citing } : {}),
        })
          .then((payload) => {
            if (!alive || comparisonStore.getSnapshot().runId !== runId) return
            comparisonStore.patch({
              digests: Array.isArray(payload.digests) ? payload.digests : [],
              citing: payload.citing || state.citing,
              digestState: 'done',
            })
          })
          .catch((cause) => {
            if (!alive || comparisonStore.getSnapshot().runId !== runId) return
            comparisonStore.patch({ digestState: 'error', error: cause?.message || String(cause) })
          })
        return () => {
          alive = false
        }
      }, [state.open, state.digestState, state.digests.length, runId, state.mode])

      useEffect(() => {
        if (!state.open) {
          setBusy('')
          setLocalError('')
          setNotice('')
          setCiteCard(null)
        }
      }, [state.open])

      if (!state.open) return null

      const openReader = (jobId, blockId) => {
        comparisonStore.close()
        props.openReader(jobId, blockId)
      }

      const openAt = (jobId, blockId) => {
        if (!blockId) {
          openReader(jobId)
          return
        }
        const target = document.querySelector(
          '[data-pane-job="' + jobId + '"] [data-block-id="' + blockId + '"]',
        )
        if (!target) {
          openReader(jobId, blockId)
          return
        }
        target.scrollIntoView({ behavior: 'smooth', block: 'center' })
        target.classList.add('dpr-flash')
        window.setTimeout(() => target.classList.remove('dpr-flash'), 2200)
      }

      const openCitation = async ({ jobId, block, span, reference, doc }) => {
        const number = span?.numbers?.[0] || 0
        if (!reference) {
          setCiteCard({ status: 'error', number, error: '参考文献里没有这一条。' })
          return
        }
        setCiteCard({
          status: 'loading',
          number,
          reference,
          citingJobId: jobId,
          citingBlockId: block.id,
        })
        const quote = String(block.text || '')
        const start = Math.max(0, (span.originalStart ?? span.start ?? 0) - 480)
        const end = Math.min(quote.length, (span.originalEnd ?? span.end ?? 0) + 480)
        const citing = {
          jobId,
          blockId: block.id,
          page: Number(block.page) || 0,
          section: block.section || '',
          paperTitle: doc?.meta?.title || '',
          quote: quote.slice(start, end),
          before: quote.slice(Math.max(0, start - 240), start),
          after: quote.slice(end, Math.min(quote.length, end + 240)),
        }
        const referenceKey = [reference.text || '', reference.doi || '', reference.arxiv || '', reference.title || ''].join('|')
        try {
          const payload = await postApi('citations/resolve', {
            referenceText: reference.text || '',
            number,
            citing,
            referenceKey,
            doi: reference.doi || '',
            arxiv: reference.arxiv || '',
            title: reference.title || '',
          })
          setCiteCard({
            status: 'ready',
            number,
            reference,
            citingJobId: jobId,
            citingBlockId: block.id,
            payload,
            metadata: payload.metadata || null,
            jobId: payload.jobId || payload.existingJobId || '',
            analysis: payload.analysis || null,
            message: (() => {
              if (payload.kind === 'candidates') {
                const titles = (Array.isArray(payload.candidates) ? payload.candidates : [])
                  .slice(0, 3)
                  .map((candidate) => candidate?.title)
                  .filter(Boolean)
                return titles.length > 0
                  ? '多篇候选：' + titles.join(' / ') + '。去单篇选择。'
                  : '这条引用有多篇候选，小的我只能先在单篇阅读页里让陛下选。'
              }
              return payload.kind === 'none' ? payload.message || '没有找到这篇论文。' : ''
            })(),
          })
        } catch (cause) {
          setCiteCard({
            status: 'error',
            number,
            reference,
            citingJobId: jobId,
            citingBlockId: block.id,
            error: cause?.message || String(cause),
          })
        }
      }

      const ensureTable = async () => {
        if (state.table) return state.table
        if (busy === 'table') return null
        setBusy('table')
        setLocalError('')
        try {
          const payload = await postApi('compare/table', { jobIds: state.jobIds })
          if (comparisonStore.getSnapshot().runId !== runId) return null
          const table = applyTableEdits(payload.table || null, state.tableEdits)
          comparisonStore.patch({
            table,
            tableState: 'done',
            digests: Array.isArray(payload.digests) ? payload.digests : state.digests,
          })
          return table
        } catch (cause) {
          if (comparisonStore.getSnapshot().runId === runId) setLocalError(cause?.message || String(cause))
          return null
        } finally {
          setBusy('')
        }
      }

      const buildTable = async () => {
        const table = await ensureTable()
        if (!table) return null
        comparisonStore.addArtifact({ id: 'table', type: 'table', title: '七字段对照表', payload: table })
        setNotice('对照表已生成，点右侧「产物」查看。')
        return table
      }

      const judgeCitation = async () => {
        if (!state.citing?.jobId || !state.citing?.blockId) {
          setLocalError('引用对照缺少引用处。')
          return null
        }
        const cited = state.jobIds.find((id) => id !== state.citing.jobId)
        if (!cited) return null
        setBusy('citation')
        setLocalError('')
        try {
          const payload = await postApi('compare/citation', {
            citingJobId: state.citing.jobId,
            citedJobId: cited,
            blockId: state.citing.blockId,
            number: state.citing.number || 0,
            title: state.citing.title || '',
          })
          if (comparisonStore.getSnapshot().runId !== runId) return null
          const analysis = payload.analysis || null
          comparisonStore.patch({
            citation: analysis,
            citing: payload.citing || state.citing,
            citationState: 'done',
            digests: Array.isArray(payload.digests) ? payload.digests : state.digests,
          })
          if (analysis) {
            comparisonStore.addArtifact({
              id: 'citation',
              type: 'summary',
              title: '引用支持关系',
              payload: {
                text: [
                  analysis.label,
                  analysis.claim ? 'A 的主张：' + analysis.claim : '',
                  analysis.citedContribution ? 'B 的实际内容：' + analysis.citedContribution : '',
                  analysis.gap ? '缺口：' + analysis.gap : '',
                  analysis.nextSection ? '建议核对：' + analysis.nextSection : '',
                ]
                  .filter(Boolean)
                  .join('\n\n'),
              },
            })
          }
          return analysis
        } catch (cause) {
          setLocalError(cause?.message || String(cause))
          return null
        } finally {
          setBusy('')
        }
      }

      const appendSay = (content) =>
        comparisonStore.appendMessage({ role: 'assistant', content, at: new Date().toISOString() })

      const generateConcept = async (question) => {
        try {
          const payload = await postApi('compare/concept', {
            jobIds: state.jobIds,
            question:
              String(question || '').trim() ||
              '请把两篇论文的问题、方法、关键证据、结果、局限与可继续验证的缺口画成概念图。',
          })
          const concept = payload.concept || null
          if (!concept || !Array.isArray(concept.nodes) || concept.nodes.length === 0) {
            setLocalError((concept?.warnings || ['模型没有返回可渲染的概念节点']).join('；'))
            return null
          }
          comparisonStore.addArtifact({
            id: 'concept-' + Date.now().toString(36),
            type: 'concept',
            title: concept.title || '论文概念图',
            payload: concept,
          })
          setNotice(
            '概念图已生成：原文锚点 ' +
              concept.stats.grounded +
              ' · 模型归纳 ' +
              concept.stats.synthesis +
              '。',
          )
          return concept
        } catch (cause) {
          setLocalError(cause?.message || String(cause))
          return null
        }
      }

      const generateDataChart = async (question) => {
        try {
          const table = await ensureTable()
          const payload = await postApi('compare/chart', {
            jobIds: state.jobIds,
            table: table || state.table,
            question:
              String(question || '').trim() ||
              '请从对照表里选一组有原文依据的数字画图；没有一致数据就返回空 series。',
          })
          const chart = payload.chart || null
          if (!chart || chart.series.length === 0) {
            setLocalError((chart?.warnings || ['没有可画的一致数据']).join('；'))
            return null
          }
          comparisonStore.addArtifact({
            id: 'model-chart',
            type: 'chart',
            title: chart.title || '模型数据图',
            payload: { mode: 'model', ...chart },
          })
          setNotice('数据图已生成，每个数据点都能回到原文；点右侧「产物」查看。')
          return chart
        } catch (cause) {
          setLocalError(cause?.message || String(cause))
          return null
        }
      }

      const runCommand = async (kind) => {
        if (kind === 'table') {
          await buildTable()
          return
        }
        if (kind === 'logic') {
          const table = await ensureTable()
          if (table) {
            comparisonStore.addArtifact(buildLogicArtifact(table, state.digests))
            setNotice('论证链已生成，点右侧「产物」查看。')
          }
          return
        }
        if (kind === 'concept') {
          await generateConcept()
          return
        }
        if (kind === 'structure') {
          comparisonStore.addArtifact(buildStructureArtifact(state.digests))
          setNotice('文献结构统计已生成，点右侧「产物」查看。')
          return
        }
        if (kind === 'coverage') {
          const table = await ensureTable()
          if (table) {
            comparisonStore.addArtifact(buildCoverageArtifact(table, state.digests))
            setNotice('证据覆盖度图已生成，点右侧「产物」查看。')
          }
          return
        }
        if (kind === 'model-chart') {
          await generateDataChart()
          return
        }
        if (kind === 'report') {
          const report = buildCompareReport({
            digests: state.digests,
            table: state.table,
            annotations,
            messages: state.messages,
            citation: state.citation,
            mode: state.mode,
          })
          downloadTextFile('compare-report.md', report)
          setNotice('对照报告已生成并下载。')
          return
        }
        if (kind === 'archive') {
          const report = buildCompareReport({
            digests: state.digests,
            table: state.table,
            annotations,
            messages: state.messages,
            citation: state.citation,
            mode: state.mode,
          })
          try {
            const payload = await postApi('compare/archive', {
              jobIds: state.jobIds,
              mode: state.mode,
              titles: state.digests.map((digest) => digest.title),
              report,
              table: state.table,
              citation: state.citation,
              annotations,
              messages: state.messages,
            })
            setNotice('已归档：' + (payload.id || ''))
          } catch (cause) {
            setLocalError(cause?.message || String(cause))
          }
          return
        }
        if (kind === 'summary') {
          const answer = await askWorkspace('请用要点总结这几篇的共同点、关键差异，以及下一步该读哪一节。', true)
          if (answer) {
            comparisonStore.addArtifact({
              id: 'summary',
              type: 'summary',
              title: '对照总结',
              payload: { text: answer },
            })
          }
          return
        }
        if (kind === 'citation') {
          await judgeCitation()
          return
        }
        if (kind === 'version') {
          if (state.jobIds.length < 2) return
          try {
            const payload = await postApi('compare/version-diff', {
              leftJobId: state.jobIds[0],
              rightJobId: state.jobIds[1],
            })
            comparisonStore.addArtifact({
              id: 'version',
              type: 'version',
              title: '版本差异',
              payload,
            })
            setNotice('版本差异已生成，点右侧「产物」查看。')
          } catch (cause) {
            setLocalError(cause?.message || String(cause))
          }
          return
        }
        if (kind === 'simulate-citation') {
          const first = state.digests[0]
          const blockId = first?.excerpts?.[0]?.blockId || first?.sections?.[0]?.blockId
          if (first && blockId) {
            comparisonStore.open({
              mode: 'citation',
              jobIds: state.jobIds,
              citing: { jobId: first.jobId, blockId, number: 12, title: first.title },
            })
          }
        }
      }

      const askWorkspace = async (text, skipCommand = false) => {
        const question = String(text || '').trim()
        if (!question || state.chatState === 'running') return null
        if (!skipCommand && /生成.*(对照表|表格)/.test(question)) {
          comparisonStore.appendMessage({ role: 'user', content: question, at: new Date().toISOString() })
          const table = await buildTable()
          if (table) appendSay('已生成七字段对照表，点右侧「产物」查看；单元格里的 blockId 可以点回原段。')
          return null
        }
        if (!skipCommand && /逻辑图|论证链/.test(question)) {
          comparisonStore.appendMessage({ role: 'user', content: question, at: new Date().toISOString() })
          const table = await ensureTable()
          if (table) {
            comparisonStore.addArtifact(buildLogicArtifact(table, state.digests))
            appendSay('已生成论证链对照，点右侧「产物」查看。')
          }
          return null
        }
        if (!skipCommand && /概念图|思维导图|关系图|流程图|论证关系|研究缺口|画.*(概念|关系|流程|示意)/.test(question)) {
          comparisonStore.appendMessage({ role: 'user', content: question, at: new Date().toISOString() })
          const concept = await generateConcept(question)
          if (concept) {
            appendSay(
              '已生成概念图：有原文锚点的节点可以点回左侧原段；虚线节点是模型归纳，不冒充论文原话。',
            )
          }
          return null
        }
        if (!skipCommand && /数据图|数值图|趋势图|柱状图|折线图|模型图表|带出处.*图/.test(question)) {
          comparisonStore.appendMessage({ role: 'user', content: question, at: new Date().toISOString() })
          if (await generateDataChart(question)) {
            appendSay('已生成有原文出处的数据图；图中每个点都可以回到对应 blockId。')
          }
          return null
        }
        if (!skipCommand && /覆盖度|证据覆盖/.test(question)) {
          comparisonStore.appendMessage({ role: 'user', content: question, at: new Date().toISOString() })
          const table = await ensureTable()
          if (table) {
            comparisonStore.addArtifact(buildCoverageArtifact(table, state.digests))
            appendSay('已生成证据覆盖度图，点右侧「产物」查看。')
          }
          return null
        }
        if (!skipCommand && /文献结构图|结构统计|图表计数/.test(question)) {
          comparisonStore.appendMessage({ role: 'user', content: question, at: new Date().toISOString() })
          comparisonStore.addArtifact(buildStructureArtifact(state.digests))
          appendSay('已生成文献结构统计（图/表/公式/参考文献计数），点右侧「产物」查看。')
          return null
        }
        if (!skipCommand && /画.*图|图表/.test(question)) {
          comparisonStore.appendMessage({ role: 'user', content: question, at: new Date().toISOString() })
          const concept = await generateConcept(question)
          if (concept) appendSay('已生成概念图，点右侧「产物」查看。')
          return null
        }
        if (!skipCommand && /引用.*(支持|判断|关系)/.test(question) && state.mode === 'citation') {
          comparisonStore.appendMessage({ role: 'user', content: question, at: new Date().toISOString() })
          const analysis = await judgeCitation()
          if (analysis) appendSay('已核对引用支持关系，点右侧「产物」查看。')
          return null
        }
        const history = state.messages.slice(-8)
        const pendingNotes = annotations.filter(
          (item) => !item.sent && state.jobIds.includes(item.jobId),
        )
        comparisonStore.appendMessage({ role: 'user', content: question, at: new Date().toISOString() })
        comparisonStore.patch({ chatState: 'running', chatError: '' })
        try {
          const payload = await postApi('compare/ask', {
            jobIds: state.jobIds,
            mode: state.mode,
            question,
            history,
            ...(state.mode === 'citation' && state.citing ? { citing: state.citing } : {}),
            ...(pendingNotes.length > 0
              ? {
                  annotations: pendingNotes.map((item) => ({
                    jobId: item.jobId,
                    question: item.question,
                    context: item.context,
                    segments: item.segments,
                  })),
                }
              : {}),
          })
          if (comparisonStore.getSnapshot().runId !== runId) return null
          const answer = String(payload.answer || '').trim()
          comparisonStore.appendMessage({ role: 'assistant', content: answer, at: new Date().toISOString() })
          comparisonStore.patch({ chatState: 'idle' })
          if (pendingNotes.length > 0) annotationStore.markSent(pendingNotes.map((item) => item.id))
          return answer
        } catch (cause) {
          if (comparisonStore.getSnapshot().runId === runId) {
            comparisonStore.patch({
              chatState: 'idle',
              chatError: cause?.message || String(cause),
            })
          }
          return null
        }
      }

      const digestState = state.digestState
      const openArtifacts = (state.openArtifacts || [])
        .map((id) => state.artifacts.find((item) => item.id === id))
        .filter(Boolean)
      const title =
        state.digests.length > 0
          ? state.digests.map((digest) => '《' + digest.title + '》').join(' × ')
          : t('compare.loading')
      const compareSectionCount = state.digests.reduce(
        (sum, digest) => sum + (Array.isArray(digest.sections) ? digest.sections.length : 0),
        0,
      )

      return React.createElement(
        'div',
        { className: 'dpr-compareRoot' },
        React.createElement('div', {
          className: 'dpr-compareBackdrop',
          onClick: () => comparisonStore.close(),
        }),
        React.createElement(
          'div',
          { className: 'dpr-comparePanel', role: 'dialog', 'aria-modal': true, 'aria-label': t('compare.surveyTitle') },
          React.createElement(
            'header',
            { className: 'dpr-compareHeader' },
            React.createElement(
              'div',
              { className: 'dpr-cmpHeadMain' },
              React.createElement(
                'span',
                { className: 'dpr-compareKicker' },
                state.mode === 'citation' ? t('compare.citationTitle') : t('compare.surveyTitle'),
              ),
              React.createElement('h2', { className: 'dpr-compareTitle' }, title),
            ),
            React.createElement(
              'div',
              { className: 'dpr-cmpHeadActions' },
              React.createElement(
                'span',
                { className: 'dpr-cmpMetric' },
                React.createElement('b', null, state.digests.length || '—'),
                t('compare.papers'),
              ),
              React.createElement(
                'span',
                { className: 'dpr-cmpMetric' },
                React.createElement('b', null, compareSectionCount || '—'),
                t('compare.sections'),
              ),
              busy ? React.createElement('span', { className: 'dpr-compareStats' }, busy === 'table' ? '生成表格…' : '核对引用…') : null,
              React.createElement(
                'button',
                { type: 'button', className: 'dpr-compareClose', onClick: () => comparisonStore.close() },
                t('compare.close'),
              ),
            ),
          ),
          state.mode === 'citation' && state.citing
            ? React.createElement(
                'div',
                { className: 'dpr-cmpCitingBanner' },
                React.createElement(
                  'div',
                  null,
                  React.createElement('span', { className: 'dpr-compareKicker' }, '引用 [' + (state.citing.number || '?') + '] · ' + (state.citing.title || '引用方')),
                  React.createElement('p', null, '「' + String(state.citing.text || '').slice(0, 260) + (String(state.citing.text || '').length > 260 ? '…' : '') + '」'),
                ),
                React.createElement(
                  'button',
                  { type: 'button', className: 'dpr-back', onClick: () => openAt(state.citing.jobId, state.citing.blockId) },
                  '回到引用处',
                ),
              )
            : null,
          localError
            ? React.createElement(
                'div',
                { className: 'dpr-error dpr-cmpTopError', role: 'alert' },
                React.createElement('span', { 'aria-hidden': true }, '⚠'),
                React.createElement('span', null, localError),
              )
            : null,
          React.createElement(
            'div',
            { className: 'dpr-cmpBody' },
            React.createElement(
              'div',
              { className: 'dpr-cmpPapers' },
              digestState === 'error'
                ? React.createElement(
                    'div',
                    { className: 'dpr-cmpPaneError' },
                    React.createElement('p', null, t('compare.loadFailed') + (state.error || '')),
                    React.createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'dpr-back',
                        onClick: () => comparisonStore.patch({ digests: [], digestState: 'loading', error: '' }),
                      },
                      '重试',
                    ),
                  )
                : null,
              digestState === 'loading' && state.digests.length === 0
                ? React.createElement('div', { className: 'dpr-cmpPaneLoading' }, t('compare.loading'))
                : null,
              state.digests.map((digest, index) =>
                React.createElement(PaperPane, {
                  key: digest.jobId,
                  jobId: digest.jobId,
                  tag: 'P' + (index + 1),
                  digest,
                  annotations,
                  onCite: openCitation,
                  onOpenReader: openReader,
                  onFocusAnnotation: () => comparisonStore.setTab('notes'),
                  onAnnotationSaved: () => comparisonStore.setTab('notes'),
                }),
              ),
            ),
            React.createElement(CompareWorkspace, {
              state,
              digests: state.digests,
              annotations,
              onAsk: askWorkspace,
              onCommand: runCommand,
              onFocusBlock: openAt,
              onOpenReader: openReader,
              onClear: () => comparisonStore.clearChat(),
              onTab: (tab) => comparisonStore.setTab(tab),
            }),
          ),
          React.createElement(CompareArtifactRail, {
            state,
            onToggle: () => comparisonStore.toggleArtList(),
            onOpen: (id) => comparisonStore.openArtifact(id),
          }),
          notice ? React.createElement('div', { className: 'dpr-cmpToast' }, notice) : null,
          openArtifacts.map((artifact, index) =>
            React.createElement(CompareArtifactWindow, {
              key: artifact.id,
              artifact,
              index,
              onClose: () => comparisonStore.closeArtifact(artifact.id),
              onEditCell: (fieldKey, jobId, text) =>
                comparisonStore.editTableCell(fieldKey, jobId, text),
              onOpenBlock: (jobId, blockId) => {
                comparisonStore.closeArtifact(artifact.id)
                openAt(jobId, blockId)
              },
            }),
          ),
          React.createElement(CompareCitationCard, {
            state: citeCard,
            onClose: () => setCiteCard(null),
            onOpenReader: (jobId, blockId) => openReader(jobId, blockId),
          }),
        ),
      )
    }

    function FileImportBody(props) {
      const { useState, useEffect, useRef } = React
      const actions = props.useTabInfo().tab.actions
      const t = props.t
      const path = props.path
      const inputRef = useRef(null)
      const [file, setFile] = useState(null)
      const [error, setError] = useState('')
      const [dragging, setDragging] = useState(false)
      const [uploading, setUploading] = useState(false)
      const [job, setJob] = useState(null)
      const [elapsed, setElapsed] = useState(0)
      const [jobId, setJobId] = useState(() => {
        try {
          return window.localStorage?.getItem(JOB_STORAGE_KEY) || ''
        } catch {
          return ''
        }
      })

      const rememberJob = (id) => {
        setJobId(id)
        try {
          if (id) window.localStorage?.setItem(JOB_STORAGE_KEY, id)
          else window.localStorage?.removeItem(JOB_STORAGE_KEY)
        } catch {
          // 隐私模式/存储不可用时，当前页仍可继续工作。
        }
      }

      const refresh = async (id) => {
        const response = await fetch(apiUrl('jobs/' + id), { cache: 'no-store' })
        if (response.status === 404) {
          rememberJob('')
          setJob(null)
          setError(t('import.failed') + '任务已不在内存里。')
          return
        }
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(payload.error || response.statusText)
        setJob(payload)
      }

      useEffect(() => {
        if (!jobId) return undefined
        let alive = true
        refresh(jobId).catch((cause) => {
          if (alive) setError(t('import.failed') + (cause?.message || String(cause)))
        })
        return () => {
          alive = false
        }
      }, [jobId])

      useEffect(() => {
        if (!jobId || !job || job.status !== 'running') return undefined
        const timer = setInterval(() => {
          refresh(jobId).catch((cause) => setError(t('import.failed') + (cause?.message || String(cause))))
        }, 1000)
        return () => clearInterval(timer)
      }, [jobId, job?.status])

      useEffect(() => {
        if (!job || job.status !== 'running') return undefined
        const start = Date.parse(job.startedAt) || Date.now()
        const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)))
        tick()
        const timer = setInterval(tick, 1000)
        return () => clearInterval(timer)
      }, [job?.startedAt, job?.status])

      const choose = () => inputRef.current?.click()

      const selectFile = (candidate) => {
        if (!candidate) return
        if (!isPdfFile(candidate)) {
          setError(t('import.onlyPdf'))
          return
        }
        if (Number(candidate.size) > MAX_UPLOAD_BYTES) {
          setError(t('import.tooLarge'))
          return
        }
        setError('')
        setFile(candidate)
        setJob(null)
        rememberJob('')
      }

      const start = async () => {
        if (!file || uploading) return
        setUploading(true)
        setError('')
        try {
          const response = await fetch(apiUrl('import'), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/pdf',
              'X-DPR-Filename': encodeURIComponent(file.name || 'paper.pdf'),
            },
            body: file,
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(payload.error || response.statusText)
          rememberJob(payload.jobId)
          setJob({
            id: payload.jobId,
            status: 'running',
            stage: 'queued',
            message: payload.message || t('import.uploading'),
            originalName: file.name,
            startedAt: new Date().toISOString(),
          })
        } catch (cause) {
          setError(t('import.uploadFailed') + (cause?.message || String(cause)))
        } finally {
          setUploading(false)
        }
      }

      const reset = () => {
        rememberJob('')
        setFile(null)
        setJob(null)
        setError('')
        setElapsed(0)
      }

      const backHome = () => actions.openTab(HOME_KIND, { replaceTab: true })

      if (job) {
        return React.createElement(LoadingPanel, {
          job,
          t,
          elapsed,
          onOpenReader: () => actions.openTab(READER_KIND, { params: { jobId: job.id } }),
          onReset: reset,
          onBack: backHome,
        })
      }

      const dropProps = {
        role: 'button',
        tabIndex: 0,
        className: 'dpr-drop' + (dragging ? ' is-over' : ''),
        onClick: choose,
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            choose()
          }
        },
        onDragOver: (event) => {
          event.preventDefault()
          event.stopPropagation()
          setDragging(true)
        },
        onDragLeave: (event) => {
          event.stopPropagation()
          setDragging(false)
        },
        onDrop: (event) => {
          event.preventDefault()
          event.stopPropagation()
          setDragging(false)
          selectFile(event.dataTransfer?.files?.[0])
        },
      }

      return React.createElement(
        'div',
        { className: 'dpr-pane dpr-importPane' },
        React.createElement(
          'header',
          { className: 'dpr-pageTopbar' },
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dpr-back dpr-pageBack',
              'aria-label': t('path.back'),
              onClick: backHome,
            },
            '← ' + t('path.back'),
          ),
          React.createElement(
            'span',
            { className: 'dpr-pageCrumb' },
            t('type.home') + ' / ',
            React.createElement('b', null, t(path.titleKey)),
          ),
          React.createElement('span', { className: 'dpr-pageLocal' }, t('import.local')),
        ),
        React.createElement(
          'div',
          { className: 'dpr-importContent' },
          React.createElement(
            'section',
            { className: 'dpr-importHero' },
            React.createElement(
              'div',
              { className: 'dpr-importHeroCopy' },
              React.createElement('div', { className: 'dpr-eyebrow' }, t('import.eyebrow')),
              React.createElement('h2', { className: 'dpr-question' }, t('import.title')),
              React.createElement('p', { className: 'dpr-sub' }, t('import.lead')),
            ),
            React.createElement(
              'div',
              { className: 'dpr-importMascot' },
              mascotArt(t, 112, { src: MASCOT_ASSETS.homeOpenBook, altKey: 'art.mascot.home' }),
            ),
          ),
          React.createElement(
            'div',
            { className: 'dpr-stepper', 'aria-label': t('import.title') },
            React.createElement(
              'span',
              { className: 'dpr-step is-active' },
              React.createElement('i', { 'aria-hidden': true }),
              t('import.stepChoose'),
            ),
            React.createElement(
              'span',
              { className: 'dpr-step' },
              React.createElement('i', { 'aria-hidden': true }),
              t('import.stepCopy'),
            ),
            React.createElement(
              'span',
              { className: 'dpr-step' },
              React.createElement('i', { 'aria-hidden': true }),
              t('import.stepRead'),
            ),
          ),
          React.createElement(
            'div',
            { className: 'dpr-import' },
            React.createElement('input', {
              ref: inputRef,
              className: 'dpr-fileInput',
              type: 'file',
              accept: 'application/pdf,.pdf',
              'aria-label': t('import.choose'),
              onChange: (event) => selectFile(event.target?.files?.[0]),
            }),
            React.createElement(
              'div',
              dropProps,
              React.createElement('span', { className: 'dpr-dropTitle' }, t('import.dropTitle')),
              React.createElement('span', { className: 'dpr-dropHint' }, t('import.dropHint')),
            ),
            file
              ? React.createElement(
                  'div',
                  { className: 'dpr-fileCard' },
                  React.createElement('span', { className: 'dpr-fileGlyph', 'aria-hidden': true }, 'PDF'),
                  React.createElement(
                    'span',
                    { className: 'dpr-fileBody' },
                    React.createElement('b', null, file.name),
                    React.createElement(
                      'small',
                      null,
                      formatBytes(file.size) + ' · ' + t('import.waitingFile'),
                    ),
                  ),
                  React.createElement(
                    'button',
                    { type: 'button', className: 'dpr-fileChange', onClick: choose },
                    t('import.change'),
                  ),
                )
              : null,
            React.createElement(
              'button',
              { type: 'button', className: 'dpr-choose', onClick: choose },
              t('import.choose'),
            ),
            error
              ? React.createElement(
                  'div',
                  { className: 'dpr-readerMascotError' },
                  mascotArt(t, 156, { src: MASCOT_ASSETS.readLying, altKey: 'art.mascot.readerError' }),
                  React.createElement(
                    'div',
                    { className: 'dpr-error', role: 'alert' },
                    React.createElement('span', { 'aria-hidden': true }, '⚠'),
                    React.createElement('span', null, error),
                  ),
                )
              : null,
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dpr-primary',
                disabled: !file || uploading,
                onClick: start,
              },
              uploading ? t('import.uploading') : t('import.start'),
            ),
            React.createElement(
              'ul',
              { className: 'dpr-todo' },
              path.itemKeys.map((key) =>
                React.createElement(
                  'li',
                  { key: key, className: 'dpr-todoItem' },
                  React.createElement('span', { className: 'dpr-bullet', 'aria-hidden': true }),
                  React.createElement('span', null, t(key)),
                ),
              ),
            ),
            React.createElement('p', { className: 'dpr-note' }, t('import.background')),
          ),
        ),
      )
    }

    /**
     * 论文术语即时查词卡。
     * 只解释当前语境；不收藏、不打分，也不和主对话历史耦合。
     */
    function TermLookupCard({ state, onClose, onRetry, onLocate }) {
      const { useEffect } = React
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])
      if (!state) return null
      const lookup = state.result?.lookup || null
      const locator = lookup?.locator || {}
      const viewportWidth = window.innerWidth || 1440
      const viewportHeight = window.innerHeight || 900
      const narrow = viewportWidth <= 600
      const width = Math.min(430, viewportWidth - 24)
      const desiredLeft = state.rect?.left ?? viewportWidth - width - 18
      const desiredTop = (state.rect?.bottom ?? 86) + 8
      const estimatedHeight = Math.min(540, viewportHeight - 24)
      const style = narrow
        ? { left: 8, right: 8, bottom: 8, top: 'auto', width: 'auto', maxHeight: '72vh' }
        : {
            left: Math.max(12, Math.min(viewportWidth - width - 12, desiredLeft)),
            top: Math.max(12, Math.min(viewportHeight - estimatedHeight - 12, desiredTop)),
          }
      const kindLabels = {
        word: '单词',
        phrase: '短语',
        acronym: '缩写',
        identifier: '标识符',
        symbol: '符号',
        unknown: '未分类',
      }
      const confidenceLabels = {
        high: '高置信',
        medium: '中等置信',
        low: '低置信',
        unknown: '置信未知',
      }
      return React.createElement(
        'aside',
        {
          className: 'dpr-termCard' + (narrow ? ' is-narrow' : ''),
          style,
          role: 'dialog',
          'aria-label': '论文术语查词',
          onMouseDown: (event) => event.stopPropagation(),
        },
        React.createElement(
          'div',
          { className: 'dpr-termHead' },
          React.createElement(
            'div',
            { className: 'dpr-termHeadMain' },
            React.createElement('div', { className: 'dpr-termKicker' }, '论文术语 · 当前语境'),
            React.createElement('h3', { className: 'dpr-termWord' }, state.term || lookup?.term || '查词'),
            lookup
              ? React.createElement(
                  'div',
                  { className: 'dpr-termBadges' },
                  React.createElement(
                    'span',
                    { className: 'dpr-termBadge' },
                    kindLabels[lookup.kind] || '术语',
                  ),
                  React.createElement(
                    'span',
                    {
                      className:
                        'dpr-termBadge' +
                        (lookup.confidence === 'high'
                          ? ' is-high'
                          : lookup.confidence === 'low' || lookup.confidence === 'unknown'
                            ? ' is-low'
                            : ''),
                    },
                    confidenceLabels[lookup.confidence] || '置信未知',
                  ),
                  React.createElement(
                    'span',
                    { className: 'dpr-termBadge' },
                    lookup.source === 'paper-glossary' ? '论文术语表' : '模型语境解释',
                  ),
                  lookup.cached ? React.createElement('span', { className: 'dpr-termBadge' }, '本轮已查') : null,
                )
              : null,
          ),
          React.createElement(
            'button',
            { type: 'button', className: 'dpr-termClose', onClick: onClose, 'aria-label': '关闭查词' },
            '×',
          ),
        ),
        state.status === 'loading'
          ? React.createElement('div', { className: 'dpr-termLoading' }, '正在核对论文定义与当前句子…')
          : state.status === 'error'
            ? React.createElement(
                'div',
                { className: 'dpr-termError', role: 'alert' },
                state.error || '查词失败',
              )
            : lookup
              ? React.createElement(
                  React.Fragment,
                  null,
                  React.createElement('p', { className: 'dpr-termMeaning' }, lookup.contextMeaning),
                  lookup.expanded
                    ? React.createElement(
                        'p',
                        { className: 'dpr-termField' },
                        React.createElement('b', null, '论文内全称'),
                        React.createElement('span', null, lookup.expanded),
                      )
                    : null,
                  lookup.definitions?.length > 1
                    ? React.createElement(
                        'p',
                        { className: 'dpr-termField' },
                        React.createElement('b', null, '论文内候选全称'),
                        React.createElement(
                          'span',
                          null,
                          lookup.definitions
                            .map((item, index) => (index + 1) + '. ' + item.expanded)
                            .join('\n'),
                        ),
                      )
                    : null,
                  lookup.generalMeaning
                    ? React.createElement(
                        'p',
                        { className: 'dpr-termField' },
                        React.createElement('b', null, '模型补充含义（未作词典核验）'),
                        React.createElement('span', null, lookup.generalMeaning),
                      )
                    : null,
                  lookup.roleInSentence
                    ? React.createElement(
                        'p',
                        { className: 'dpr-termField' },
                        React.createElement('b', null, '在当前句中的作用'),
                        React.createElement('span', null, lookup.roleInSentence),
                      )
                    : null,
                  lookup.sentence
                    ? React.createElement('p', { className: 'dpr-termQuote' }, '当前句：' + lookup.sentence)
                    : null,
                  lookup.warnings?.length
                    ? React.createElement(
                        'ul',
                        { className: 'dpr-termWarnings' },
                        lookup.warnings.map((warning, index) =>
                          React.createElement('li', { key: index }, warning),
                        ),
                      )
                    : null,
                  React.createElement(
                    'div',
                    { className: 'dpr-termFoot' },
                    React.createElement(
                      'span',
                      { className: 'dpr-termLocator' },
                      [
                        locator.page ? 'p.' + locator.page : '',
                        locator.section || '',
                        locator.blockId || '',
                      ]
                        .filter(Boolean)
                        .join(' · '),
                    ),
                    locator.blockId && onLocate
                      ? React.createElement(
                          'button',
                          { type: 'button', onClick: () => onLocate(locator.blockId) },
                          '定位原段',
                        )
                      : null,
                    state.status === 'error' && onRetry
                      ? React.createElement('button', { type: 'button', onClick: onRetry }, '重试')
                      : null,
                  ),
                )
              : React.createElement('div', { className: 'dpr-termError' }, '查词没有返回结果'),
        state.status === 'error' && onRetry
          ? React.createElement(
              'button',
              { type: 'button', className: 'dpr-back', onClick: onRetry },
              '重新查词',
            )
          : null,
      )
    }

    function SourcePageDialog(props) {
      const { useState, useEffect } = React
      const { jobId, page, pageCount, onPage, onClose, t } = props
      const [failed, setFailed] = useState(false)
      const url = sourcePageUrl(jobId, page)
      useEffect(() => {
        setFailed(false)
      }, [url])
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [onClose])
      const maxPage = Math.max(0, Number(pageCount) || 0)
      return React.createElement(
        'div',
        {
          className: 'dpr-sourceOverlay',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': t('reader.page') + page,
          onClick: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        React.createElement(
          'div',
          {
            className: 'dpr-sourceCard',
            onClick: (event) => event.stopPropagation(),
          },
          React.createElement(
            'div',
            { className: 'dpr-citeHead' },
            React.createElement(
              'div',
              { className: 'dpr-citeHeadMain' },
              React.createElement('div', { className: 'dpr-citeKicker' }, 'SOURCE PAGE'),
              React.createElement('div', { className: 'dpr-citeTitle' }, t('reader.page') + page),
              React.createElement(
                'div',
                { className: 'dpr-citeMetaLine' },
                maxPage ? page + ' / ' + maxPage : '原版页图像',
              ),
            ),
            React.createElement(
              'button',
              { type: 'button', className: 'dpr-citeClose', onClick: onClose, 'aria-label': '关闭' },
              '×',
            ),
          ),
          React.createElement(
            'div',
            { className: 'dpr-sourceBody' },
            failed
              ? React.createElement(
                  'div',
                  { className: 'dpr-sourceError', role: 'alert' },
                  '这一页原图暂时打不开。源页文件可能缺失，论文正文和批注仍可正常使用。',
                )
              : React.createElement('img', {
                  className: 'dpr-sourceImage',
                  src: url,
                  alt: t('reader.page') + page,
                  onError: () => setFailed(true),
                }),
          ),
          React.createElement(
            'div',
            { className: 'dpr-sourceActions' },
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dpr-back',
                disabled: page <= 1,
                onClick: () => onPage(page - 1),
              },
              '上一页',
            ),
            React.createElement(
              'a',
              {
                className: 'dpr-back',
                href: url,
                target: '_blank',
                rel: 'noreferrer',
              },
              '在新窗口打开',
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                className: 'dpr-back',
                disabled: !maxPage || page >= maxPage,
                onClick: () => onPage(page + 1),
              },
              '下一页',
            ),
          ),
        ),
      )
    }

    function ReaderBody(props) {
      const { useState, useEffect, useRef } = React
      const tabInfo = props.useTabInfo().tab
      const actions = tabInfo.actions
      const navigation = tabInfo.navigation
      const params = navigation?.params
      const parsed = parseReaderAddress(navigation?.address)
      const jobId = params?.jobId || parsed?.jobId
      const targetBlockId = params?.blockId || parsed?.blockId || ''
      const fromCitation = params?.fromCitation || null
      const t = props.t
      const [docState, setDocState] = useState(null)
      const [docJobId, setDocJobId] = useState('')
      const [versionTargets, setVersionTargets] = useState([])
      // 只有「这份 doc 属于当前 jobId」时才渲染；切篇瞬间旧 doc 立刻失效。
      const doc = docJobId === jobId ? docState : null
      const [error, setError] = useState('')
      const [selection, setSelection] = useState(null)
      const [draftQuestion, setDraftQuestion] = useState('')
      const [askStatus, setAskStatus] = useState('')
      const [termLookup, setTermLookup] = useState(null)
      const [barReady, setBarReady] = useState(false)
      const [citationIndex, setCitationIndex] = useState(null)
      const [citationPreview, setCitationPreview] = useState(null)
      const [sourcePagePreview, setSourcePagePreview] = useState(0)
      const [langMode, setLangMode] = useState(() => {
        try {
          return (jobId && window.localStorage?.getItem(LANG_STORAGE_PREFIX + jobId)) || 'original'
        } catch {
          return 'original'
        }
      })
      const [translations, setTranslations] = useState(null)
      const [translationState, setTranslationState] = useState(null)
      const [translationNonce, setTranslationNonce] = useState(0)
      const [formulaData, setFormulaData] = useState(null)
      const [formulaState, setFormulaState] = useState(null)
      const [formulaDrafts, setFormulaDrafts] = useState({})
      const [tableData, setTableData] = useState(null)
      const [tableState, setTableState] = useState(null)
      const [reviewData, setReviewData] = useState(null)
      const [reviewState, setReviewState] = useState(null)
      const [reviewPanelOpen, setReviewPanelOpen] = useState(false)
      const [glossaryOpen, setGlossaryOpen] = useState(false)
      const [glossaryEntries, setGlossaryEntries] = useState([])
      const [glossarySaving, setGlossarySaving] = useState(false)
      const [glossaryError, setGlossaryError] = useState('')
      const annotations = useAnnotations()
      const rootRef = useRef(null)
      const outlineRef = useRef(null)
      const flashTimer = useRef(null)
      const barRef = useRef(null)
      const anchorRef = useRef(null)
      const sideRef = useRef('above')
      const sideChosenRef = useRef(false)
      const barReadyRef = useRef(false)
      const frameRef = useRef(0)
      const lastPosRef = useRef({ left: -1, top: -1 })
      const translationStartedRef = useRef('')

      useEffect(() => {
        if (typeof window === 'undefined') return undefined
        const handlePayload = (payload) => {
          if (payload?.type !== 'doraemon-paper-reader/open') return
          if (!JOB_ID_RE.test(String(payload.jobId || ''))) return
          if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(payload.blockId || ''))) return
          const source = payload.fromCitation
          const fromCitation =
            source && JOB_ID_RE.test(String(source.jobId || ''))
              ? {
                  jobId: String(source.jobId),
                  blockId: /^[A-Za-z0-9_-]{1,80}$/.test(String(source.blockId || ''))
                    ? String(source.blockId)
                    : '',
                  number: Number(source.number) || 0,
                  title: String(source.title || '').slice(0, 200),
                }
              : null
          actions.openTab(READER_KIND, {
            params: {
              jobId: String(payload.jobId),
              blockId: String(payload.blockId),
              ...(fromCitation ? { fromCitation } : {}),
            },
          })
        }
        const onMessage = (event) => {
          if (event.origin !== window.location.origin) return
          handlePayload(event.data)
        }
        const onChannelMessage = (event) => handlePayload(event.data)
        window.addEventListener('message', onMessage)
        const channel =
          typeof BroadcastChannel === 'function'
            ? new BroadcastChannel('doraemon-paper-reader')
            : null
        if (channel) channel.addEventListener('message', onChannelMessage)
        return () => {
          window.removeEventListener('message', onMessage)
          if (channel) channel.close()
        }
      }, [actions])

      useEffect(() => {
        if (!jobId) {
          setDocState(null)
          setDocJobId('')
          setError(t('reader.noDoc'))
          return undefined
        }
        // 切篇时先卸掉旧 doc：否则旧论文的图表会拿新 jobId 去请求资产（一串 500）。
        setDocState(null)
        setDocJobId('')
        setError('')
        let alive = true
        fetch(apiUrl('jobs/' + jobId + '/mirrordoc.json'), { cache: 'no-store' })
          .then(async (response) => {
            const payload = await response.json().catch(() => ({}))
            if (!response.ok) throw new Error(payload.error || response.statusText)
            if (alive) {
              setDocState(payload)
              setDocJobId(jobId)
            }
          })
          .catch((cause) => {
            if (alive) setError(t('reader.failed') + (cause?.message || String(cause)))
          })
        return () => {
          alive = false
        }
      }, [jobId])

      // 阅读位置按篇记住：切页签、看引用再回来都落回原处；指定 blockId 时以引用处为准。
      useEffect(() => {
        const root = rootRef.current
        if (!root || !doc || !jobId) return undefined
        const key = SCROLL_STORAGE_PREFIX + jobId
        let frame = 0
        let restoreFrame = 0
        let lastScroll = readerScrollMemory.get(jobId) || 0
        if (!targetBlockId) {
          try {
            const stored = Number(window.localStorage?.getItem(key))
            if ((!lastScroll || !Number.isFinite(lastScroll)) && Number.isFinite(stored) && stored > 0) {
              lastScroll = stored
            }
          } catch {
            // 存储不可用时只影响记忆，不影响阅读。
          }
          if (lastScroll > 0) {
            const restore = (attempt = 0) => {
              const current = rootRef.current
              if (!current) return
              current.scrollTop = lastScroll
              if (attempt < 2) restoreFrame = window.requestAnimationFrame(() => restore(attempt + 1))
            }
            restoreFrame = window.requestAnimationFrame(() => restore())
          }
        }
        const save = () => {
          if (!lastScroll || !Number.isFinite(lastScroll)) return
          readerScrollMemory.set(jobId, lastScroll)
          try {
            window.localStorage?.setItem(key, String(lastScroll))
          } catch {
            // 同上。
          }
        }
        const onScroll = () => {
          lastScroll = rootRef.current?.scrollTop || 0
          readerScrollMemory.set(jobId, lastScroll)
          if (frame) return
          frame = window.requestAnimationFrame(() => {
            frame = 0
            save()
          })
        }
        root.addEventListener('scroll', onScroll, { passive: true })
        return () => {
          root.removeEventListener('scroll', onScroll)
          if (frame) window.cancelAnimationFrame(frame)
          if (restoreFrame) window.cancelAnimationFrame(restoreFrame)
          save()
        }
      }, [doc, jobId, targetBlockId])

      useEffect(() => {
        const root = rootRef.current
        const outline = outlineRef.current
        if (!root || !outline || !doc) return undefined
        const update = () => {
          const bar = root.querySelector('.dpr-readerBar')
          const current = outlineRef.current
          if (!bar || !current) return
          const rootTop = root.getBoundingClientRect().top
          const barBottom = bar.getBoundingClientRect().bottom
          const offset = Math.max(8, Math.round(barBottom - rootTop + 8))
          current.style.setProperty('--dpr-outline-top', offset + 'px')
        }
        update()
        window.addEventListener('resize', update)
        const bar = root.querySelector('.dpr-readerBar')
        const observer = typeof ResizeObserver === 'function' && bar ? new ResizeObserver(update) : null
        observer?.observe(bar)
        return () => {
          window.removeEventListener('resize', update)
          observer?.disconnect()
        }
      }, [doc, jobId])

      useEffect(() => {
        if (!jobId) return
        try {
          const saved = window.localStorage?.getItem(LANG_STORAGE_PREFIX + jobId)
          setLangMode(saved || 'original')
        } catch {
          setLangMode('original')
        }
        setTranslations(null)
        setTranslationState(null)
      }, [jobId])

      useEffect(() => {
        if (!jobId) return undefined
        let alive = true
        setVersionTargets([])
        fetch(apiUrl('jobs/' + jobId + '/versions'), { cache: 'no-store' })
          .then(async (response) => (response.ok ? response.json() : null))
          .then((payload) => {
            if (alive) setVersionTargets(Array.isArray(payload?.versions) ? payload.versions : [])
          })
          .catch(() => {
            if (alive) setVersionTargets([])
          })
        return () => {
          alive = false
        }
      }, [jobId])

      useEffect(() => {
        if (!jobId) {
          setFormulaData(null)
          setTableData(null)
          setReviewData(null)
          return undefined
        }
        let alive = true
        const load = async () => {
          try {
            const [formulaResponse, tableResponse, reviewResponse] = await Promise.all([
              fetch(apiUrl('jobs/' + jobId + '/formulas'), { cache: 'no-store' }),
              fetch(apiUrl('jobs/' + jobId + '/tables'), { cache: 'no-store' }),
              fetch(apiUrl('jobs/' + jobId + '/review'), { cache: 'no-store' }),
            ])
            if (formulaResponse.ok && alive) setFormulaData(await formulaResponse.json())
            if (tableResponse.ok && alive) setTableData(await tableResponse.json())
            if (reviewResponse.ok && alive) setReviewData(await reviewResponse.json())
          } catch {
            // 视觉增强失败不阻塞阅读。
          }
        }
        void load()
        return () => {
          alive = false
        }
      }, [jobId])

      useEffect(() => {
        if (!jobId || formulaState?.status !== 'running') return undefined
        let alive = true
        const timer = setInterval(async () => {
          try {
            const response = await fetch(apiUrl('jobs/' + jobId + '/formulas'), { cache: 'no-store' })
            const payload = await response.json().catch(() => ({}))
            if (alive && response.ok) {
              setFormulaState(payload)
              if (payload.status !== 'running') setFormulaData(payload)
            }
          } catch {
            // 继续轮询。
          }
        }, 1000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [jobId, formulaState?.status])

      useEffect(() => {
        if (!jobId || tableState?.status !== 'running') return undefined
        let alive = true
        const timer = setInterval(async () => {
          try {
            const response = await fetch(apiUrl('jobs/' + jobId + '/tables'), { cache: 'no-store' })
            const payload = await response.json().catch(() => ({}))
            if (alive && response.ok) {
              setTableState(payload)
              if (payload.status !== 'running') setTableData(payload)
            }
          } catch {
            // 继续轮询。
          }
        }, 1000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [jobId, tableState?.status])

      useEffect(() => {
        if (!jobId || reviewState?.status !== 'running') return undefined
        let alive = true
        const timer = setInterval(async () => {
          try {
            const response = await fetch(apiUrl('jobs/' + jobId + '/review'), { cache: 'no-store' })
            const payload = await response.json().catch(() => ({}))
            if (!alive || !response.ok) return
            setReviewState(payload)
            if (payload.status !== 'running') {
              setReviewData(payload)
              setTranslations(null)
              setTranslationNonce((value) => value + 1)
            }
          } catch {
            // 继续轮询。
          }
        }, 1200)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [jobId, reviewState?.status])

      useEffect(() => {
        if (!jobId || langMode === 'original') return undefined
        let alive = true
        let timer = 0
        const loadTranslations = async () => {
          const response = await fetch(apiUrl('jobs/' + jobId + '/translations'), { cache: 'no-store' })
          if (!response.ok) return false
          const payload = await response.json().catch(() => null)
          if (!payload || !alive) return false
          setTranslations(payload)
          setTranslationState({ status: 'done', stage: 'done', message: '译文已就绪' })
          return true
        }
        const poll = async () => {
          try {
            const response = await fetch(apiUrl('jobs/' + jobId + '/translate'), { cache: 'no-store' })
            const payload = await response.json().catch(() => ({}))
            if (!alive) return
            if (response.ok) setTranslationState(payload)
            if (payload.status === 'done') {
              await loadTranslations()
              return
            }
            if (payload.status === 'failed' || payload.status === 'cancelled') return
          } catch {
            // 网络抖动不结束轮询。
          }
          if (alive) timer = setTimeout(poll, 1000)
        }
        const start = async () => {
          try {
            const response = await fetch(apiUrl('jobs/' + jobId + '/translate'), { cache: 'no-store' })
            let payload = await response.json().catch(() => ({}))
            if (!alive) return
            if (response.ok && payload.status === 'done') {
              setTranslationState(payload)
              await loadTranslations()
              return
            }
            if (response.ok && payload.status === 'running') {
              setTranslationState(payload)
              timer = setTimeout(poll, 800)
              return
            }
            if (response.ok && (payload.status === 'failed' || payload.status === 'cancelled')) {
              setTranslationState(payload)
              return
            }
            const started = await fetch(apiUrl('jobs/' + jobId + '/translate'), { method: 'POST' })
            payload = await started.json().catch(() => ({}))
            if (!alive) return
            if (!started.ok) {
              setTranslationState({ status: 'failed', stage: 'failed', message: payload.error || '翻译启动失败' })
              return
            }
            setTranslationState(payload)
            if (payload.status === 'done') await loadTranslations()
            else if (payload.status !== 'failed') timer = setTimeout(poll, 800)
          } catch (cause) {
            if (alive) setTranslationState({ status: 'failed', stage: 'failed', message: cause?.message || String(cause) })
          }
        }
        void start()
        return () => {
          alive = false
          clearTimeout(timer)
        }
      }, [jobId, langMode, translationNonce])

      useEffect(() => {
        if (jobId) void annotationStore.loadForJob(jobId)
      }, [jobId])

      useEffect(() => {
        if (!jobId) {
          setCitationIndex(null)
          return undefined
        }
        let alive = true
        fetch(apiUrl('jobs/' + jobId + '/citations'), { cache: 'no-store' })
          .then((response) => (response.ok ? response.json() : null))
          .then((payload) => {
            if (alive) setCitationIndex(payload)
          })
          .catch(() => {
            if (alive) setCitationIndex(null)
          })
        return () => {
          alive = false
        }
      }, [jobId])

      const flashBlock = (blockId) => {
        if (!blockId || !rootRef.current) {
          return false
        }
        const element = rootRef.current.querySelector('[data-block-id="' + blockId + '"]')
        if (!element) {
          return false
        }
        element.scrollIntoView({ behavior: 'smooth', block: 'center' })
        element.classList.remove('dpr-flash')
        void element.offsetWidth
        element.classList.add('dpr-flash')
        clearTimeout(flashTimer.current)
        flashTimer.current = setTimeout(() => element.classList.remove('dpr-flash'), 2600)
        return true
      }

      const runCitationAnalysis = async (state) => {
        setCitationPreview((current) =>
          current?.key === state.key ? { ...current, stage: 'analyzing', error: '' } : current,
        )
        try {
          const response = await fetch(apiUrl('citations/analyze'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jobId: state.jobId || '',
              referenceText: state.reference?.text || state.reference?.raw || '',
              number: state.number,
              citing: state.citing,
              referenceKey: state.referenceKey || '',
              baseReferenceKey: state.baseReferenceKey || '',
              metadata: state.metadata || {},
              abstract: state.metadata?.abstract || '',
              version: state.version || null,
            }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) {
            const error = new Error(payload.error || response.statusText || '引用概览生成失败')
            error.statusCode = response.status
            throw error
          }
          if (payload.kind === 'invalid') {
            setCitationPreview((current) =>
              current?.key === state.key
                ? {
                    ...current,
                    stage: 'error',
                    error: payload.message || '这条参考文献缺少可解析信息。',
                  }
                : current,
            )
            return
          }
          setCitationPreview((current) =>
            current?.key === state.key
              ? {
                  ...current,
                  stage: 'ready',
                  analysis: payload,
                  metadata: payload.metadata || current.metadata,
                  error: '',
                }
              : current,
          )
        } catch (cause) {
          setCitationPreview((current) =>
            current?.key === state.key
              ? {
                  ...current,
                  stage: cause?.statusCode === 503 ? 'metadata' : 'error',
                  error: cause?.message || String(cause),
                }
              : current,
          )
        }
      }

      const startCitationPreview = async (block, span, number, override = {}) => {
        const reference = citationIndex?.references?.find((entry) => entry.number === number)
        if (!reference) {
          setCitationPreview({
            stage: 'error',
            number,
            error: '参考文献编号 [' + number + '] 没有找到对应条目。',
          })
          return
        }
        const referenceText = String(override.referenceText || reference.text || '').trim()
        if (!referenceText) {
          setCitationPreview({
            stage: 'error',
            number,
            reference,
            error: '参考文献 [' + number + '] 缺少可解析原文，暂时无法打开引用详情。',
          })
          return
        }
        const blockText = String(block.text || '')
        const spanStart = span.originalStart ?? span.start
        const spanEnd = span.originalEnd ?? span.end
        const quoteStart = Math.max(0, spanStart - 520)
        const quoteEnd = Math.min(blockText.length, spanEnd + 520)
        const citing = {
          jobId,
          blockId: block.id || '',
          page: Number(block.page) || 0,
          section: block.section || '',
          paperTitle: doc?.meta?.title || '',
          quote: blockText.slice(quoteStart, quoteEnd),
          before: blockText.slice(Math.max(0, spanStart - 320), spanStart),
          after: blockText.slice(spanEnd, Math.min(blockText.length, spanEnd + 320)),
        }
        const key = [block.id, span.start, number, Date.now()].join(':')
        const baseReferenceKey = [
          referenceText,
          reference.doi || '',
          reference.arxiv || '',
          reference.title || '',
        ].join('|')
        const referenceKey = [
          referenceText,
          override.doi || reference.doi || '',
          override.arxiv || reference.arxiv || '',
          override.title || reference.title || '',
        ].join('|')
        const base = {
          key,
          stage: 'resolving',
          block,
          span,
          referenceKey,
          baseReferenceKey,
          numbers: span.numbers,
          number,
          reference: { ...reference, ...override, text: referenceText },
          citing,
          metadata: null,
          version: null,
          jobId: '',
          job: null,
          analysis: null,
          error: '',
        }
        setCitationPreview(base)
        try {
          const response = await fetch(apiUrl('citations/resolve'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              referenceText: base.reference.text,
              number,
              citing,
              referenceKey: baseReferenceKey,
              doi: override.doi || '',
              arxiv: override.arxiv || '',
              title: override.title || '',
            }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) {
            const error = new Error(payload.error || response.statusText || '引用解析失败')
            error.statusCode = response.status
            throw error
          }
          const next = {
            ...base,
            resolved: payload,
            metadata: payload.metadata || null,
            version: payload.version || null,
            reference: payload.reference || base.reference,
          }
          if (payload.kind === 'cached') {
            setCitationPreview({
              ...next,
              stage: 'ready',
              analysis: payload.analysis,
              metadata: payload.metadata || next.metadata,
              version: payload.version || next.version,
              savedAt: payload.savedAt || '',
              cached: true,
              jobId: '',
            })
            return
          }
          if (payload.kind === 'candidates') {
            setCitationPreview({ ...next, stage: 'candidates', candidates: payload.candidates || [] })
            return
          }
          if (payload.kind === 'none') {
            setCitationPreview({ ...next, stage: 'error', error: payload.message || '没有找到这篇论文。' })
            return
          }
          if (payload.kind === 'invalid') {
            setCitationPreview({
              ...next,
              stage: 'error',
              error: payload.message || '这条参考文献缺少可解析信息。',
            })
            return
          }
          if (payload.kind === 'existing') {
            setCitationPreview({ ...next, stage: 'analyzing', jobId: payload.jobId })
            await runCitationAnalysis({ ...next, stage: 'analyzing', jobId: payload.jobId })
            return
          }
          if (payload.kind === 'running') {
            setCitationPreview({ ...next, stage: 'fetching', jobId: payload.jobId })
            return
          }
          // metadata-only：先展示元数据/摘要，再尝试基于摘要生成概览。
          setCitationPreview({ ...next, stage: 'analyzing' })
          await runCitationAnalysis(next)
        } catch (cause) {
          setCitationPreview((current) =>
            current?.key === key
              ? { ...current, stage: 'error', error: cause?.message || String(cause) }
              : current,
          )
        }
      }

      const openCitationPreview = (block, span) => {
        if (!span?.numbers?.length) return
        setSelection(null)
        if (span.numbers.length > 1) {
          setCitationPreview({
            stage: 'choose',
            numbers: span.numbers,
            number: span.numbers[0],
            block,
            span,
          })
          return
        }
        void startCitationPreview(block, span, span.numbers[0])
      }

      const chooseCitationCandidate = async (candidate) => {
        const current = citationPreview
        if (!current?.block || !current?.span) return
        if (candidate?.doi || candidate?.arxiv) {
          await startCitationPreview(current.block, current.span, current.number, {
            doi: candidate.doi || '',
            arxiv: candidate.arxiv || '',
            title: candidate.title || '',
            referenceText: current.reference?.text || '',
          })
          return
        }
        const next = {
          ...current,
          stage: 'analyzing',
          metadata: {
            ...candidate,
            title: candidate?.title || current.reference?.title || '',
            abstract: candidate?.abstract || '',
          },
          reference: {
            ...current.reference,
            title: candidate?.title || current.reference?.title || '',
            doi: candidate?.doi || '',
            arxiv: candidate?.arxiv || '',
          },
          referenceKey: [
            current.baseReferenceKey || '',
            candidate?.title || '',
            candidate?.doi || '',
            candidate?.arxiv || '',
          ].join('|'),
          baseReferenceKey: current.baseReferenceKey || '',
          error: '',
        }
        setCitationPreview(next)
        await runCitationAnalysis(next)
      }

      const openCitationLookup = (state) => {
        if (!state) return
        const payload = citationLookupParams(state)
        setCitationPreview(null)
        actions.openTab(LOOKUP_KIND, { params: payload })
      }

      const cycleLangMode = () => {
        setLangMode((current) => {
          const next = current === 'original' ? 'zh' : current === 'zh' ? 'bilingual' : 'original'
          try {
            window.localStorage?.setItem(LANG_STORAGE_PREFIX + jobId, next)
          } catch {
            // 隐私模式下只影响本次阅读。
          }
          return next
        })
      }

      const translationFor = (blockId) => translations?.blocks?.[blockId] || null
      const translatedMeta = translations?.meta || null

      const openGlossary = async () => {
        if (!jobId) return
        setGlossaryError('')
        try {
          const response = await fetch(apiUrl('jobs/' + jobId + '/glossary'), { cache: 'no-store' })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(payload.error || '读取术语表失败')
          setGlossaryEntries(payload.entries || [])
          setGlossaryOpen(true)
        } catch (cause) {
          setGlossaryError(cause?.message || String(cause))
          setGlossaryEntries([])
          setGlossaryOpen(true)
        }
      }

      const saveVersion = async (kind) => {
        if (!jobId) return
        try {
          const response = await fetch(apiUrl('jobs/' + jobId + '/version'), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(payload.error || response.statusText)
          setDocState((current) => (current ? { ...current, version: payload.version } : current))
        } catch (cause) {
          setAskStatus('版本保存失败：' + (cause?.message || String(cause)))
        }
      }

      const startVisualJob = async (kind) => {
        if (!jobId) return
        const setState = kind === 'formulas' ? setFormulaState : setTableState
        const setData = kind === 'formulas' ? setFormulaData : setTableData
        setState({
          status: 'running',
          stage: 'prepare',
          message: kind === 'formulas' ? '小的我逐张识别公式…' : '小的我逐张整理表格…',
          done: 0,
          total: 0,
        })
        try {
          const response = await fetch(apiUrl('jobs/' + jobId + '/' + kind), { method: 'POST' })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(payload.error || response.statusText)
          setState(payload)
          if (payload.status === 'done' || payload.status === 'empty') setData(payload)
        } catch (cause) {
          setState({
            status: 'failed',
            stage: 'failed',
            message: cause?.message || String(cause),
            done: 0,
            total: 0,
          })
        }
      }

      const startReview = async (force = false) => {
        if (!jobId) return
        setReviewPanelOpen(false)
        setReviewState({
          status: 'running',
          stage: 'backtranslate',
          message: '小的我先做回译…',
          done: 0,
          total: translations?.coverage?.segments || 0,
        })
        try {
          const response = await fetch(
            apiUrl('jobs/' + jobId + '/review') + (force ? '?force=1' : ''),
            { method: 'POST' },
          )
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(payload.error || response.statusText)
          setReviewState(payload)
          if (payload.status !== 'running') {
            setReviewData(payload)
            setTranslations(null)
            setTranslationNonce((value) => value + 1)
          }
        } catch (cause) {
          setReviewState({
            status: 'failed',
            stage: 'failed',
            message: cause?.message || String(cause),
            done: 0,
            total: 0,
          })
        }
      }

      const cancelBackgroundTask = async (kind) => {
        if (!jobId) return
        try {
          const payload = await postApi('jobs/' + jobId + '/cancel-task', { kind })
          if (payload?.state) {
            if (kind === 'translation') setTranslationState(payload.state)
            else if (kind === 'review') setReviewState(payload.state)
            else if (kind === 'formula') setFormulaState(payload.state)
            else if (kind === 'table') setTableState(payload.state)
          }
        } catch (cause) {
          if (kind === 'translation') {
            setTranslationState((state) => ({
              ...(state || {}),
              status: 'failed',
              message: cause?.message || String(cause),
            }))
          } else if (kind === 'review') {
            setReviewState((state) => ({
              ...(state || {}),
              status: 'failed',
              message: cause?.message || String(cause),
            }))
          }
        }
      }

      const locateReviewIssue = (taskId) => {
        const blockId =
          taskId.startsWith('meta:abstract') || taskId.startsWith('abstract')
            ? '__meta_abstract'
            : taskId.split(':')[0]
        setReviewPanelOpen(false)
        if (blockId === '__meta_abstract') {
          flashBlock(blockId)
          return
        }
        if (!blockId || blockId === 'meta' || blockId === 'title') {
          rootRef.current?.scrollTo?.({ top: 0, behavior: 'smooth' })
          return
        }
        flashBlock(blockId)
      }

      const copyLatex = async (latex) => {
        try {
          await navigator.clipboard.writeText(String(latex || ''))
          setAskStatus('LaTeX 已复制。')
        } catch {
          setAskStatus('复制失败，请手动选择 LaTeX 文本。')
        }
      }

      const saveFormula = async (blockId) => {
        if (!jobId || !blockId) return
        try {
          const response = await fetch(apiUrl('jobs/' + jobId + '/formulas/' + encodeURIComponent(blockId)), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ latex: formulaDrafts[blockId] || '' }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(payload.error || response.statusText)
          setFormulaData((current) => ({
            ...current,
            blocks: { ...(current?.blocks || {}), [blockId]: payload.block },
          }))
          setFormulaDrafts((current) => {
            const next = { ...current }
            delete next[blockId]
            return next
          })
          setAskStatus('公式 LaTeX 已保存。')
        } catch (cause) {
          setAskStatus('公式保存失败：' + (cause?.message || String(cause)))
        }
      }

      const saveGlossary = async (entries) => {
        if (!jobId) return
        setGlossarySaving(true)
        setGlossaryError('')
        try {
          const response = await fetch(apiUrl('jobs/' + jobId + '/glossary'), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(payload.error || '保存术语表失败')
          setGlossaryEntries(payload.entries || [])
          setGlossaryOpen(false)
          setTranslations(null)
          setTranslationState(
            langMode === 'original'
              ? null
              : { status: 'running', stage: 'prepare', message: '术语表已更新，准备重译…', done: 0, total: 0 },
          )
          setTranslationNonce((value) => value + 1)
        } catch (cause) {
          setGlossaryError(cause?.message || String(cause))
        } finally {
          setGlossarySaving(false)
        }
      }

      useEffect(() => {
        if (!doc || !targetBlockId) return undefined
        flashBlock(targetBlockId)
        return undefined
      }, [doc, targetBlockId, navigation?.revision])

      useEffect(() => () => clearTimeout(flashTimer.current), [])

      useEffect(() => {
        const current = citationPreview
        if (!current?.jobId || current.stage !== 'fetching') return undefined
        let alive = true
        const poll = async () => {
          try {
            const response = await fetch(apiUrl('jobs/' + current.jobId), { cache: 'no-store' })
            const job = await response.json().catch(() => ({}))
            if (!alive) return
            if (!response.ok) {
              setCitationPreview((state) =>
                state?.key === current.key
                  ? { ...state, stage: 'error', error: job.error || '预览任务不在了' }
                  : state,
              )
              return
            }
            if (job.status === 'done') {
              const next = {
                ...current,
                stage: 'analyzing',
                job,
                metadata: job.metadata || current.metadata,
                version: job.version || current.version,
              }
              setCitationPreview(next)
              await runCitationAnalysis(next)
              return
            }
            if (job.status === 'failed') {
              setCitationPreview((state) =>
                state?.key === current.key
                  ? { ...state, stage: 'error', job, error: job.error || job.message || '预览取回失败' }
                  : state,
              )
              return
            }
            setCitationPreview((state) =>
              state?.key === current.key
                ? { ...state, job, metadata: job.metadata || state.metadata, version: job.version || state.version }
                : state,
            )
          } catch {
            // 网络抖动不结束任务；下一次轮询继续。
          }
        }
        void poll()
        const timer = setInterval(poll, 1000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [citationPreview?.jobId, citationPreview?.stage])

      const back = () => actions.openTab('doraemon-paper-file', { replaceTab: true })

      const captureSelection = (event) => {
        if (typeof window === 'undefined') return
        // 在批注浮层里打字/点按钮时，不要让宿主正文的 mouseup/keyup 把浮层清掉。
        if (event?.target?.closest?.('.dpr-selectionBar')) return
        if (event?.type === 'mouseup' && event.button !== 0) return
        const sel = window.getSelection()
        const root = rootRef.current
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !root) {
          setSelection(null)
          return
        }
        const range = sel.getRangeAt(0)
        if (!root.contains(range.commonAncestorContainer)) {
          setSelection(null)
          return
        }
        const quote = String(sel.toString() || '').replace(/\s+/g, ' ').trim()
        if (quote.length < 2) {
          setSelection(null)
          return
        }
        const start = range.startContainer
        const startElement = start.nodeType === 3 ? start.parentElement : start
        const end = range.endContainer
        const endElement = end.nodeType === 3 ? end.parentElement : end
        if (!startElement?.closest?.('[data-block-id]') || !endElement?.closest?.('[data-block-id]')) {
          setSelection(null)
          return
        }
        const blockElements = [...root.querySelectorAll('[data-block-id]')].filter((element) =>
          range.intersectsNode(element),
        )
        if (blockElements.length === 0) {
          setSelection(null)
          return
        }
        const segments = blockElements.map((element) => {
          const textElement = element.querySelector('.dpr-readerText')
          const blockText = String(element.dataset.sourceText || textElement?.textContent || element.textContent || '').replace(/\s+/g, ' ')
          const kind = element.tagName === 'FIGURE' ? element.dataset.kind || 'figure' : 'text'
          const segmentQuote = blockElements.length === 1 ? quote : blockText.slice(0, 1600)
          const index = blockText.indexOf(segmentQuote)
          return {
            quote: segmentQuote,
            before: index >= 0 ? blockText.slice(Math.max(0, index - 260), index) : '',
            after: index >= 0 ? blockText.slice(index + segmentQuote.length, index + segmentQuote.length + 260) : '',
            page: Number(element.dataset.page) || 0,
            blockId: element.dataset.blockId || '',
            section: element.dataset.section || '',
            kind,
            label: element.dataset.label || '',
            asset: element.dataset.asset || '',
            latex: element.dataset.latex || '',
            // 文本段也给整段原文，避免模型只拿到 80 字选区和一小截前后文后去翻 PDF。
            content: blockText.slice(0, 4000),
          }
        })
        const rect = range.getBoundingClientRect()
        const scroller = rootRef.current
        const scrollerRect = scroller.getBoundingClientRect()
        anchorRef.current = {
          top: rect.top - scrollerRect.top + scroller.scrollTop,
          bottom: rect.bottom - scrollerRect.top + scroller.scrollTop,
          center: rect.left + rect.width / 2 - scrollerRect.left + scroller.scrollLeft,
        }
        sideChosenRef.current = false
        barReadyRef.current = false
        setBarReady(false)
        setSelection({
          quote,
          segments,
          rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        })
        setDraftQuestion('')
        setAskStatus('')
      }

      const addToChat = () => {
        if (!selection || !jobId) return
        const pages = new Set(selection.segments.map((segment) => Number(segment.page)).filter(Boolean))
        const nearbyAssets = (doc?.blocks ?? [])
          .filter((block) => pages.has(Number(block.page)) && ['figure', 'table', 'equation'].includes(block.type))
          .slice(0, 6)
          .map((block) => ({
            kind: block.type,
            label: block.label || '',
            page: Number(block.page) || 0,
            caption: String(block.caption || block.text || '').slice(0, 320),
          }))
        annotationStore.add({
          jobId,
          segments: selection.segments.map((segment) => {
            const citationPath =
              'work/doraemon-paper-cites/' + jobId + '/' + (segment.blockId || '') + '.dprcite'
            const citationBase =
              (typeof window !== 'undefined' && window.location?.origin
                ? window.location.origin
                : '') + '/doraemon-paper-reader/api/open'
            const citationUrl =
              citationBase +
              '?jobId=' +
              encodeURIComponent(jobId) +
              '&blockId=' +
              encodeURIComponent(segment.blockId || '')
            return {
              ...segment,
              citationPath,
              citation: '[p.' + (segment.page || '?') + '](' + citationPath + ')',
              citationUrl,
              citationDeepLink:
                'dsh-resource://doraemon-paper/' + jobId + '/' + (segment.blockId || ''),
            }
          }),
          question: draftQuestion.trim(),
          context: {
            paper: {
              title: doc?.meta?.title || '',
              doi: doc?.meta?.doi || '',
              arxiv: doc?.meta?.arxivId || '',
            },
            version: doc?.version || {},
            brief: doc?.meta?.brief || {},
            nearbyAssets,
          },
          sent: false,
        })
        setAskStatus(t('reader.added'))
        setSelection(null)
      }

      const requestTermLookup = async (request) => {
        const source =
          request ||
          (selection?.segments?.length === 1
            ? {
                term: selection.quote,
                blockId: selection.segments[0].blockId,
                before: selection.segments[0].before,
                after: selection.segments[0].after,
              }
            : null)
        if (!source || !jobId) {
          setTermLookup({
            status: 'error',
            term: selection?.quote || '查词',
            rect: selection?.rect,
            request: null,
            error: '请只选择一个词、缩写或短语，不要跨多个段落。',
          })
          return
        }
        const requestId = String(Date.now()) + Math.random().toString(36).slice(2)
        setTermLookup({
          status: 'loading',
          term: source.term,
          rect: selection?.rect || termLookup?.rect,
          request: source,
          requestId,
        })
        setSelection(null)
        try {
          const payload = await postApi('jobs/' + jobId + '/term-lookup', source)
          setTermLookup((current) =>
            current?.requestId === requestId
              ? {
                  ...current,
                  status: 'ready',
                  result: payload,
                }
              : current,
          )
        } catch (cause) {
          setTermLookup((current) =>
            current?.requestId === requestId
              ? { ...current, status: 'error', error: cause?.message || String(cause) }
              : current,
          )
        }
      }

      const locateTermBlock = (blockId) => {
        setTermLookup(null)
        const target = rootRef.current?.querySelector('[data-block-id="' + blockId + '"]')
        if (!target) return
        target.scrollIntoView({ behavior: 'smooth', block: 'center' })
        target.classList.add('dpr-flash')
        window.setTimeout(() => target.classList.remove('dpr-flash'), 2200)
      }

      const openAssetComposer = (block, event) => {
        event.preventDefault()
        event.stopPropagation()
        const caption = String(block.caption || block.text || '').replace(/\s+/g, ' ').trim()
        const quote = caption || block.label || block.type
        const scroller = rootRef.current
        const scrollerRect = scroller?.getBoundingClientRect?.() || { top: 0, left: 0 }
        anchorRef.current = {
          top: event.clientY - scrollerRect.top + (scroller?.scrollTop || 0),
          bottom: event.clientY - scrollerRect.top + (scroller?.scrollTop || 0),
          center: event.clientX - scrollerRect.left + (scroller?.scrollLeft || 0),
        }
        sideChosenRef.current = false
        barReadyRef.current = false
        setBarReady(false)
        setSelection({
          quote,
          segments: [
            {
              quote,
              before: '',
              after: '',
              page: Number(block.page) || 0,
              blockId: block.id,
              section: block.section || '',
              kind: block.type,
              label: block.label || '',
              asset: block.asset || '',
              latex:
                block.type === 'equation' && formulaData?.blocks?.[block.id]?.valid
                  ? formulaData.blocks[block.id].latex || ''
                  : '',
              content: String(
                block.type === 'equation' && formulaData?.blocks?.[block.id]?.valid
                  ? formulaData.blocks[block.id].latex
                  : block.text || caption || '',
              )
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 4000),
            },
          ],
          rect: { left: event.clientX, top: event.clientY, width: 0, height: 0 },
        })
        setDraftQuestion('')
        setAskStatus('')
      }
      let lastInlinePage = null
      const pageBadge = (page, options = {}) => {
        const normalizedPage = Number(page) || 0
        const always = Boolean(options.always)
        if (!normalizedPage || !jobId) return null
        if (!always && lastInlinePage === normalizedPage) return null
        if (!always) lastInlinePage = normalizedPage
        return (
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dpr-readerPage' + (always ? ' is-special' : ' is-flow'),
              title: t('reader.page') + normalizedPage,
              'aria-label': t('reader.page') + normalizedPage,
              'data-page-group': always ? 'special' : 'flow',
              onMouseDown: (event) => event.stopPropagation(),
              onClick: (event) => {
                event.preventDefault()
                event.stopPropagation()
                setSourcePagePreview(normalizedPage)
              },
            },
            t('reader.page') + normalizedPage,
          )
        )
      }

      const citationButton = (block, span, text, key) =>
        React.createElement(
          'button',
          {
            key,
            type: 'button',
            className: 'dpr-citeLink',
            title: '查看引用 [' + span.numbers.join(',') + ']',
            'aria-label': '查看引用 [' + span.numbers.join(',') + ']',
            onMouseDown: (event) => event.stopPropagation(),
            onClick: (event) => {
              event.preventDefault()
              event.stopPropagation()
              openCitationPreview(block, span)
            },
          },
          text,
        )

      const renderText = (block) => {
        const spans = citationIndex?.byBlock?.[block.id]
        if (!spans?.length) return block.text
        return splitCitationText(block.text, spans).map((part, index) => {
          if (part.type === 'text') {
            return React.createElement('span', { key: 't' + index }, part.text)
          }
          return citationButton(block, part.span, part.text, 'c' + index)
        })
      }

      const segmentSource = (block, segment) => {
        const spans = (citationIndex?.byBlock?.[block.id] || [])
          .filter((span) => span.start >= segment.start && span.end <= segment.end)
          .map((span) => ({
            ...span,
            start: span.start - segment.start,
            end: span.end - segment.start,
            originalStart: span.start,
            originalEnd: span.end,
          }))
        if (spans.length === 0) return segment.source
        return splitCitationText(segment.source, spans).map((part, index) => {
          if (part.type === 'text') return React.createElement('span', { key: 't' + index }, part.text)
          return citationButton(
            block,
            { ...part.span, start: part.span.originalStart, end: part.span.originalEnd },
            part.text,
            'c' + index,
          )
        })
      }

      const renderTargetText = (block, segment) => {
        const target = String(segment?.target || '')
        const targetSpans = segment?.targetSpans || []
        if (!targetSpans.length) return target
        const sourceSpans = citationIndex?.byBlock?.[block.id] || []
        return splitCitationText(target, targetSpans).map((part, index) => {
          if (part.type === 'text') return React.createElement('span', { key: 'tt' + index }, part.text)
          const sourceSpan = sourceSpans.find(
            (span) => span.numbers.join(',') === part.span.numbers.join(','),
          )
          return citationButton(
            block,
            sourceSpan || {
              ...part.span,
              start: segment.start,
              end: segment.end,
            },
            part.text,
            'tc' + index,
          )
        })
      }

      const translatedText = (block) => {
        const translated = translationFor(block.id)
        if (!translated?.segments?.length) return renderText(block)
        return translated.segments.map((segment, index) =>
          React.createElement(
            'span',
            { key: 'tr' + index },
            segment.target ? renderTargetText(block, segment) : '',
          ),
        )
      }

      const bilingualSegments = (block) => {
        const translated = translationFor(block.id)
        if (!translated?.segments?.length) return null
        return translated.segments.map((segment, index) =>
          React.createElement(
            'span',
            { className: 'dpr-biPair', key: 'bi' + index },
            React.createElement('span', { className: 'dpr-biSource' }, segmentSource(block, segment)),
            React.createElement(
              'span',
              { className: 'dpr-biTarget' },
                segment.target ? renderTargetText(block, segment) : '（这一段还没有译文）',
            ),
          ),
        )
      }

      const renderBlock = (block) => {
        const id = block.id
        if (block.type === 'title' || block.type === 'abstract' || block.type === 'keywords') return null
        if (block.type === 'separator') {
          return React.createElement('hr', {
            key: id,
            id,
            className: 'dpr-readerSeparator',
            'data-block-id': id,
            'data-page': block.page,
            'data-rule-id': block.ruleId || '',
            'aria-hidden': 'true',
          })
        }
        if (block.type === 'heading') {
          const level = Math.min(4, Math.max(2, Number(block.level || 1) + 1))
          const translated = translationFor(block.id)
          const pairs = langMode === 'bilingual' ? bilingualSegments(block) : null
          const content =
            pairs && pairs.length > 0
              ? React.createElement('span', { className: 'dpr-biBlock' }, pairs)
              : React.createElement(
                  'span',
                  { className: 'dpr-readerText' },
                  langMode === 'zh' && translated?.segments ? translatedText(block) : renderText(block),
                )
          return React.createElement(
            'h' + level,
            {
              key: id,
              id,
              className: 'dpr-readerH',
              'data-block-id': id,
              'data-page': block.page,
              'data-section': block.section || '',
              'data-source-text': block.text || '',
            },
            content,
            pageBadge(block.page),
            bubbleFor(block),
          )
        }
        if (block.type === 'paragraph') {
          const translated = translationFor(block.id)
          const pairs = langMode === 'bilingual' ? bilingualSegments(block) : null
          const content =
            pairs && pairs.length > 0
              ? React.createElement('div', { className: 'dpr-biBlock' }, pairs)
              : React.createElement(
                  'span',
                  { className: 'dpr-readerText' },
                  langMode === 'zh' && translated?.segments ? translatedText(block) : renderText(block),
                )
          return React.createElement(
            pairs && pairs.length > 0 ? 'div' : 'p',
            {
              key: id,
              id,
              className: 'dpr-readerP',
              'data-block-id': id,
              'data-page': block.page,
              'data-section': block.section || '',
              'data-source-text': block.text || '',
            },
            content,
            pageBadge(block.page),
            bubbleFor(block),
          )
        }
        if (block.type === 'algorithm') {
          const caption = String(block.caption || block.text || '')
          const algorithmText = String(block.algorithmText || '')
          return React.createElement(
            'figure',
            {
              key: id,
              id,
              className: 'dpr-readerFigure dpr-readerAlgorithm',
              'data-block-id': id,
              'data-page': block.page,
              'data-section': block.section || '',
              'data-kind': 'algorithm',
              'data-label': block.label || 'Algorithm',
            },
            React.createElement(
              'figcaption',
              null,
              String(caption).toLowerCase().startsWith(String(block.label || 'Algorithm').toLowerCase())
                ? null
                : React.createElement('strong', null, (block.label || 'Algorithm') + ' '),
              caption,
              pageBadge(block.page, { always: true }),
              bubbleFor(block),
            ),
            ...(block.visualRules || []).map((rule, index) =>
              React.createElement('hr', {
                key: 'algorithm-rule-' + index,
                className: 'dpr-readerAlgorithmRule',
                'data-rule-id': rule.ruleId || '',
                'aria-hidden': 'true',
              }),
            ),
            React.createElement(
              'pre',
              { className: 'dpr-readerCode', tabIndex: 0 },
              React.createElement('code', null, algorithmText),
            ),
          )
        }
        if (block.type === 'figure' || block.type === 'table' || block.type === 'equation') {
          // Equations are preserved as visual crops. Their extracted text is
          // frequently a pseudo-glyph stream and must not be shown as caption.
          const sourceCaption = block.type === 'equation' ? '' : block.caption || block.text || ''
          const translated = translationFor(block.id)
          const caption = langMode === 'zh' && translated?.segments ? translatedText(block) : sourceCaption
          const label = block.label || (block.type === 'equation' ? t('reader.equations') : '')
          const formula = block.type === 'equation' ? formulaData?.blocks?.[block.id] : null
          const tableTranslation = block.type === 'table' ? tableData?.blocks?.[block.id] : null
          const tableRows =
            tableTranslation?.valid && Array.isArray(tableTranslation.rows) ? tableTranslation.rows : []
          return React.createElement(
            'figure',
            {
              key: id,
              id,
              className: 'dpr-readerFigure',
              'data-block-id': id,
              'data-page': block.page,
              'data-section': block.section || '',
              'data-kind': block.type,
              'data-label': label || '',
              'data-asset': block.asset || '',
              'data-latex':
                block.type === 'equation' && formulaData?.blocks?.[block.id]?.valid
                  ? formulaData.blocks[block.id].latex || ''
                  : '',
              onContextMenu: (event) => openAssetComposer(block, event),
            },
            block.asset
              ? React.createElement('img', {
                  src: assetUrl(jobId, block.asset),
                  alt: caption.slice(0, 300),
                })
              : null,
            React.createElement(
              'figcaption',
              null,
              label ? React.createElement('strong', null, label + ' ') : null,
              caption,
              langMode === 'bilingual' && translated?.segments
                ? React.createElement('span', { className: 'dpr-biTarget dpr-biCaptionPair' }, translatedText(block))
                : null,
              pageBadge(block.page, { always: true }),
              bubbleFor(block),
            ),
            formula?.valid
              ? React.createElement(
                  'div',
                  { className: 'dpr-latexBox' },
                  React.createElement('code', { className: 'dpr-latexCode' }, formula.latex),
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'dpr-back',
                      onClick: (event) => {
                        event.stopPropagation()
                        void copyLatex(formula.latex)
                      },
                    },
                    '复制 LaTeX',
                  ),
                )
              : formula
                ? React.createElement(
                    'div',
                    { className: 'dpr-latexBox' },
                    React.createElement(
                      'div',
                      { className: 'dpr-formulaWarn' },
                      '这个公式未通过置信度/括号校验：' +
                        ((formula.warnings || []).join(',') || '低置信度') +
                        '。算法已自动重试两次，当前仅保留公式图；如需高级修正可手动填写，未保存前不会进入提问上下文。',
                    ),
                    React.createElement('input', {
                      type: 'text',
                      className: 'dpr-latexInput',
                      value:
                        formulaDrafts[block.id] !== undefined
                          ? formulaDrafts[block.id]
                          : formula.latex || '',
                      placeholder: '手动输入 LaTeX',
                      onChange: (event) =>
                        setFormulaDrafts((current) => ({ ...current, [block.id]: event.target.value })),
                    }),
                    React.createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'dpr-back',
                        onClick: (event) => {
                          event.stopPropagation()
                          void saveFormula(block.id)
                        },
                      },
                      '保存修正',
                    ),
                  )
                : null,
            block.type === 'table' && langMode !== 'original' && tableRows.length > 0
              ? React.createElement(
                  'div',
                  { className: 'dpr-tableTransWrap' },
                  React.createElement(
                    'table',
                    { className: 'dpr-tableTrans' },
                    React.createElement(
                      'tbody',
                      null,
                      tableRows.map((row, rowIndex) =>
                        React.createElement(
                          'tr',
                          { key: 'tr' + rowIndex },
                          row.cells.map((cell, cellIndex) =>
                            React.createElement(
                              row.header ? 'th' : 'td',
                              { key: 'tc' + cellIndex },
                              cell || '',
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                )
              : null,
            block.type === 'table' && langMode !== 'original' && tableTranslation && !tableTranslation.valid
              ? React.createElement(
                  'div',
                  { className: 'dpr-translateNote' },
                  '表格单元格译文未通过校验，仅保留原表。',
                )
              : null,
          )
        }
        if (block.type === 'code') {
          return React.createElement(
            'pre',
            {
              key: id,
              id,
              className: 'dpr-readerCode',
              'data-block-id': id,
              'data-page': block.page,
              'data-section': block.section || '',
            },
            React.createElement('code', null, block.text),
            pageBadge(block.page, { always: true }),
            bubbleFor(block),
          )
        }
        if (block.type === 'caption') {
          const translated = translationFor(block.id)
          const pairs = langMode === 'bilingual' ? bilingualSegments(block) : null
          const content =
            pairs && pairs.length > 0
              ? React.createElement('span', { className: 'dpr-biBlock' }, pairs)
              : React.createElement(
                  'span',
                  { className: 'dpr-readerText' },
                  langMode === 'zh' && translated?.segments ? translatedText(block) : block.text,
                )
          return React.createElement(
            'p',
            {
              key: id,
              id,
              className: 'dpr-readerMeta',
              'data-block-id': id,
              'data-page': block.page,
              'data-section': block.section || '',
              'data-source-text': block.text || '',
            },
            content,
            pageBadge(block.page, { always: true }),
            bubbleFor(block),
          )
        }
        return null
      }

      const bubbleFor = (block) => {
        const count = annotations.filter(
          (item) =>
            item.sent &&
            item.segments.some((segment) => segment.blockId === block.id),
        ).length
        if (count === 0) return null
        return React.createElement(
          'span',
          { className: 'dpr-bubbleWrap' },
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dpr-bubble',
              title: '这个段落有 ' + count + ' 个批注；点击回到原文',
              onClick: (event) => {
                event.stopPropagation()
                flashBlock(block.id)
              },
            },
            String(count),
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dpr-bubbleX',
              title: '删除这个段落的批注气泡',
              onClick: (event) => {
                event.stopPropagation()
                annotationStore.removeForBlock(jobId, block.id)
              },
            },
            '×',
          ),
        )
      }

      const blocks = []
      let references = []
      const flushReferences = () => {
        if (references.length === 0) return
        blocks.push(
          React.createElement(
            'ol',
            { key: 'refs-' + blocks.length, className: 'dpr-readerRefs' },
            references.map((block) =>
              React.createElement(
                'li',
                {
                  key: block.id,
                  id: block.id,
                  className: 'dpr-readerRef',
                  'data-block-id': block.id,
                  'data-page': block.page,
                  'data-section': block.section || '',
                },
                React.createElement('span', { className: 'dpr-readerText' }, block.text),
                pageBadge(block.page),
                bubbleFor(block),
              ),
            ),
          ),
        )
        references = []
      }
      for (const block of doc?.blocks ?? []) {
        if (block.type === 'reference') {
          references.push(block)
          continue
        }
        flushReferences()
        const element = renderBlock(block)
        if (element) blocks.push(element)
      }
      flushReferences()

      useEffect(() => {
        if (!selection || typeof window === 'undefined') return undefined
        let cancelled = false
        lastPosRef.current = { left: -1, top: -1 }
        const margin = 12
        const gap = 8

        const tick = () => {
          if (cancelled) return
          const root = rootRef.current
          const bar = barRef.current
          const anchor = anchorRef.current
          if (root && bar && anchor) {
            const rootRect = root.getBoundingClientRect()
            const anchorTop = rootRect.top + anchor.top - root.scrollTop
            const anchorBottom = rootRect.top + anchor.bottom - root.scrollTop
            const anchorCenter = rootRect.left + anchor.center - root.scrollLeft
            const barW = bar.offsetWidth || 300
            const barH = bar.offsetHeight || 120
            const viewportW = window.innerWidth || 1440
            const viewportH = window.innerHeight || 900
            // Keep the composer below the sticky reader toolbar and its
            // bottom rule. The toolbar is offset by the host tab strip, so a
            // hard-coded viewport coordinate would cover the title.
            const toolbar = root.querySelector('.dpr-readerBar')
            const toolbarBottom = toolbar
              ? toolbar.getBoundingClientRect().bottom
              : rootRect.top
            const viewTop = toolbarBottom + gap
            const viewBottom = viewportH - margin

            if (!sideChosenRef.current) {
              const spaceAbove = anchorTop - viewTop - gap - barH
              const spaceBelow = viewBottom - anchorBottom - gap - barH
              if (spaceAbove >= 0) sideRef.current = 'above'
              else if (spaceBelow >= 0) sideRef.current = 'below'
              else sideRef.current = spaceAbove >= spaceBelow ? 'above' : 'below'
              sideChosenRef.current = true
            }

            // Constant offset in document coordinates: the bar tracks the
            // selection exactly, stops at a viewport edge, and resumes the
            // same relative position when the selection scrolls back.
            const rawY = sideRef.current === 'above' ? anchorTop - gap - barH : anchorBottom + gap
            const x = Math.max(margin + barW / 2, Math.min(viewportW - margin - barW / 2, anchorCenter))
            const y = Math.max(viewTop, Math.min(viewBottom - barH, rawY))
            const previous = lastPosRef.current
            if (Math.abs(previous.left - x) >= 0.5 || Math.abs(previous.top - y) >= 0.5) {
              bar.style.left = x + 'px'
              bar.style.top = y + 'px'
              lastPosRef.current = { left: x, top: y }
            }
            if (!barReadyRef.current) {
              barReadyRef.current = true
              setBarReady(true)
            }
          }
          frameRef.current = window.requestAnimationFrame(tick)
        }
        tick()
        return () => {
          cancelled = true
          window.cancelAnimationFrame(frameRef.current)
        }
      }, [selection])

      const langLabel =
        langMode === 'original'
          ? t('reader.lang.original')
          : langMode === 'zh'
            ? t('reader.lang.zh')
            : t('reader.lang.bilingual')
      const versionTarget = versionTargets.find((item) => item.jobId !== jobId) || null
      const langRunning = translationState?.status === 'running'
      const langProgress =
        langRunning && translationState?.total
          ? Math.round(((translationState.done || 0) / translationState.total) * 100)
          : 0
      const equationCount = (doc?.blocks || []).filter((block) => block.type === 'equation').length
      const tableCount = (doc?.blocks || []).filter((block) => block.type === 'table').length
      const formulaRunning = formulaState?.status === 'running'
      const tableRunning = tableState?.status === 'running'
      const reviewRunning = reviewState?.status === 'running'
      const reviewIssues = reviewData?.issues || reviewData?.review?.issues || []
      const outlineItems = doc
        ? [
            ...(doc.meta?.abstract
              ? [{ id: '__meta_abstract', label: t('reader.abstract'), page: 1 }]
              : []),
            ...(doc.blocks || [])
              .filter((block) => block.type === 'heading' && block.id)
              .map((block) => ({
                id: block.id,
                label: block.text || block.id,
                page: block.page || 0,
              })),
          ]
        : []
      const jumpToOutline = (blockId) => {
        const target = rootRef.current?.querySelector('[id="' + String(blockId).replace(/"/g, '\\"') + '"]')
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }

      return React.createElement(
        'div',
        { className: 'dpr-pane dpr-readerPane' },
        React.createElement(
          'div',
          { className: 'dpr-reader', ref: rootRef },
          React.createElement(
            'div',
            { className: 'dpr-readerBar' },
            React.createElement(
              'button',
              { type: 'button', className: 'dpr-back', onClick: back },
              t('reader.back'),
            ),
            React.createElement(
              'span',
              { className: 'dpr-readerDocHeading' },
              React.createElement(
                'span',
                { className: 'dpr-readerKicker' },
                t('reader.title') + ' / ' + (doc?.version?.kind || t('reader.versionUnknown')),
              ),
              React.createElement(
                'b',
                { className: 'dpr-readerBarTitle' },
                doc?.meta?.title || t('reader.title'),
              ),
            ),
            jobId && fromCitation?.jobId
              ? React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'dpr-langSwitch',
                    title: '回到引用它的那一段',
                    onClick: () =>
                      actions.openTab(READER_KIND, {
                        params: {
                          jobId: fromCitation.jobId,
                          ...(fromCitation.blockId ? { blockId: fromCitation.blockId } : {}),
                        },
                      }),
                  },
                  '← 引用 [' + (fromCitation.number || '?') + ']',
                )
              : null,
            jobId && fromCitation?.jobId
              ? React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'dpr-langSwitch is-active',
                    title: '把引用方与被引论文放进全宽对照视图',
                    onClick: () =>
                      comparisonStore.open({
                        mode: 'citation',
                        jobIds: [fromCitation.jobId, jobId],
                        citing: {
                          jobId: fromCitation.jobId,
                          blockId: fromCitation.blockId || '',
                          number: fromCitation.number || 0,
                          title: fromCitation.title || doc?.meta?.title || '',
                        },
                      }),
                  },
                  '双篇对照',
                )
              : null,
            jobId && versionTarget
              ? React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'dpr-langSwitch',
                    title: '对照同篇论文的另一个本地版本',
                    onClick: () =>
                      comparisonStore.open({
                        mode: 'version',
                        jobIds: [jobId, versionTarget.jobId],
                      }),
                  },
                  '版本对照',
                )
              : null,
            jobId
              ? React.createElement(
                  'button',
                  {
                    type: 'button',
                    className:
                      'dpr-langSwitch' +
                      (langMode !== 'original' ? ' is-active' : '') +
                      (langRunning ? ' is-running' : ''),
                    onClick: cycleLangMode,
                    title: t('reader.lang.switch'),
                    'aria-label': '当前 ' + langLabel + '，点击切换语言',
                  },
                  langLabel + (langRunning && langProgress ? ' ' + langProgress + '%' : ''),
                  langRunning ? React.createElement('span', { className: 'dpr-langDot', 'aria-hidden': true }) : null,
                )
              : null,
            jobId
              ? React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'dpr-langSwitch',
                    onClick: openGlossary,
                    title: '查看和修改翻译术语表',
                  },
                  '术语',
                )
              : null,
            jobId && equationCount > 0
              ? React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'dpr-langSwitch' + (formulaData?.status === 'done' ? ' is-active' : ''),
                    onClick: () => startVisualJob('formulas'),
                    disabled: formulaRunning,
                    title: '把公式裁剪图转写成 LaTeX（可复制）',
                  },
                  '公式' +
                    (formulaRunning && formulaState.total
                      ? ' ' + (formulaState.done || 0) + '/' + formulaState.total
                      : ''),
                )
              : null,
            jobId && tableCount > 0
              ? React.createElement(
                  'button',
                  {
                    type: 'button',
                    className: 'dpr-langSwitch' + (tableData?.status === 'done' ? ' is-active' : ''),
                    onClick: () => startVisualJob('tables'),
                    disabled: tableRunning,
                    title: '生成表格单元格译文（数字先核对再采用）',
                  },
                  '表格' +
                    (tableRunning && tableState.total
                      ? ' ' + (tableState.done || 0) + '/' + tableState.total
                      : ''),
                )
              : null,
            jobId && (translations || reviewData?.total > 0 || reviewData?.status === 'done' || reviewRunning)
              ? React.createElement(
                  'button',
                  {
                    type: 'button',
                    className:
                      'dpr-langSwitch' +
                      (reviewData?.status === 'done' || reviewData?.status === 'warn' ? ' is-active' : ''),
                    onClick: () => {
                      if (
                        reviewIssues.length > 0 &&
                        (reviewData?.status === 'done' || reviewData?.status === 'warn')
                      ) {
                        setReviewPanelOpen(true)
                      } else {
                        void startReview(false)
                      }
                    },
                    disabled: reviewRunning,
                    title: '先回译，再检查漏译、数字、引用、因果与术语，并自动应用已校验的修订',
                  },
                  '复核' +
                    (reviewRunning && reviewState.total
                      ? ' ' + (reviewState.done || 0) + '/' + reviewState.total
                      : reviewIssues.length
                        ? ' ' + reviewIssues.length
                        : ''),
                )
              : null,
          ),
          React.createElement(
            'div',
            {
              className: 'dpr-readerBody',
              onMouseDown: (event) => {
                if (event.button !== 0) return
                if (!event.target?.closest?.('.dpr-selectionBar')) setSelection(null)
              },
              onMouseUp: (event) => captureSelection(event),
              onKeyUp: (event) => captureSelection(event),
            },
            langMode !== 'original' && translationState && translationState.status !== 'done'
              ? React.createElement(
                  'div',
                  { className: 'dpr-translateNote', role: 'status' },
                  translationState.status === 'failed'
                    ? '翻译没有完成：' + (translationState.message || translationState.error || '未知错误') + '；当前仍显示原文。'
                    : (translationState.message || '小的我正在准备译文…') +
                        (translationState.total
                          ? '（' + (translationState.done || 0) + '/' + translationState.total + '）'
                          : ''),
                  translationState.status === 'running'
                    ? React.createElement(
                        'button',
                        {
                          type: 'button',
                          className: 'dpr-back',
                          onClick: () => void cancelBackgroundTask('translation'),
                        },
                        '取消翻译',
                      )
                    : null,
                )
              : null,
            langMode !== 'original' && translations?.qa?.warnings?.length
              ? React.createElement(
                  'div',
                  { className: 'dpr-translateNote', role: 'status' },
                  '译文质量告警 ' +
                    translations.qa.warnings.length +
                    ' 条（术语/数字/引用）。可检查术语表后重译。',
                  React.createElement(
                    'button',
                    { type: 'button', className: 'dpr-back', onClick: openGlossary },
                    '术语表',
                  ),
                )
              : null,
            formulaRunning || tableRunning
              ? React.createElement(
                  'div',
                  { className: 'dpr-translateNote', role: 'status' },
                  [
                    formulaRunning
                      ? (formulaState?.message || '正在识别公式') +
                        (formulaState?.total
                          ? '（' + (formulaState.done || 0) + '/' + formulaState.total + '）'
                          : '')
                      : '',
                    tableRunning
                      ? (tableState?.message || '正在整理表格') +
                        (tableState?.total
                          ? '（' + (tableState.done || 0) + '/' + tableState.total + '）'
                          : '')
                      : '',
                  ]
                    .filter(Boolean)
                    .join(' · '),
                  formulaRunning
                    ? React.createElement(
                        'button',
                        {
                          type: 'button',
                          className: 'dpr-back',
                          onClick: () => void cancelBackgroundTask('formula'),
                        },
                        '取消公式识别',
                      )
                    : null,
                  tableRunning
                    ? React.createElement(
                        'button',
                        {
                          type: 'button',
                          className: 'dpr-back',
                          onClick: () => void cancelBackgroundTask('table'),
                        },
                        '取消表格整理',
                      )
                    : null,
                )
              : null,
            (formulaState?.status === 'failed' ||
              tableState?.status === 'failed' ||
              formulaData?.warnings?.length ||
              tableData?.warnings?.length) &&
            (formulaRunning || tableRunning || formulaData || tableData)
              ? React.createElement(
                  'div',
                  { className: 'dpr-translateNote', role: 'status' },
                  '图像增强有告警：公式 ' +
                    (formulaData?.warnings?.length || 0) +
                    ' 条，表格 ' +
                    (tableData?.warnings?.length || 0) +
                    ' 条；未通过校验的资产保留原图。',
                )
              : null,
            reviewState?.status === 'running'
              ? React.createElement(
                  'div',
                  { className: 'dpr-translateNote', role: 'status' },
                  (reviewState.message || '小的我正在复核译文…') +
                    (reviewState.total
                      ? '（' + (reviewState.done || 0) + '/' + reviewState.total + '）'
                      : ''),
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'dpr-back',
                      onClick: () => void cancelBackgroundTask('review'),
                    },
                    '取消复核',
                  ),
                )
              : reviewState?.status === 'failed'
              ? React.createElement(
                  'div',
                  { className: 'dpr-translateNote', role: 'alert' },
                  '译文复核没有完成：' + (reviewState.message || '未知错误'),
                )
              : reviewData?.status === 'done' || reviewData?.status === 'warn'
                ? React.createElement(
                    'div',
                    { className: 'dpr-translateNote', role: 'status' },
                    '译文复核：' +
                      (Number(reviewData.reviewed) || 0) +
                      ' 个小段，' +
                      (Number(reviewData.issueCount) || 0) +
                          ' 条语义问题，自动修订 ' +
                      (Number(reviewData.applied) || 0) +
                      ' 条。',
                    reviewIssues.length
                      ? React.createElement(
                          'button',
                          {
                            type: 'button',
                            className: 'dpr-back',
                            onClick: () => setReviewPanelOpen(true),
                          },
                          '查看记录',
                        )
                      : null,
                  )
                : null,
            askStatus
              ? React.createElement(
                  'div',
                  {
                    className: 'dpr-askNote',
                    role: 'status',
                    onMouseDown: (event) => event.stopPropagation(),
                    onMouseUp: (event) => event.stopPropagation(),
                  },
                  askStatus,
                )
              : null,
            error
              ? React.createElement(
                  'div',
                  { className: 'dpr-error', role: 'alert' },
                  React.createElement('span', { 'aria-hidden': true }, '⚠'),
                  React.createElement('span', null, error),
                )
              : null,
            !doc && !error ? React.createElement('p', { className: 'dpr-sub' }, t('reader.loading')) : null,
            doc
              ? React.createElement(
                  'div',
                  { className: 'dpr-readerLayout' },
                  React.createElement(
                    'aside',
                    { className: 'dpr-readerOutline', ref: outlineRef, 'aria-label': t('reader.outline') },
                    React.createElement('h3', null, t('reader.outline')),
                    React.createElement(
                      'nav',
                      null,
                      outlineItems.map((item, index) =>
                        React.createElement(
                          'button',
                          {
                            key: item.id,
                            type: 'button',
                            className: 'dpr-readerOutlineItem' + (index === 0 ? ' is-active' : ''),
                            onClick: () => jumpToOutline(item.id),
                          },
                          React.createElement('span', null, item.label),
                          item.page ? React.createElement('small', null, 'p.' + item.page) : null,
                        ),
                      ),
                    ),
                  ),
                  React.createElement(
                    'article',
                    { className: 'dpr-readerArticle' },
                    React.createElement(
                      'div',
                      { className: 'dpr-readerArticleKicker' },
                      'ARTICLE 01 · p.1',
                    ),
                  React.createElement(
                    'h1',
                    { className: 'dpr-readerTitle' },
                    langMode === 'zh' && translatedMeta?.title
                      ? translatedMeta.title
                      : doc.meta?.title || t('reader.title'),
                    langMode === 'bilingual' && translatedMeta?.title
                      ? React.createElement('span', { className: 'dpr-biTargetTitle' }, translatedMeta.title)
                      : null,
                  ),
                  React.createElement('p', { className: 'dpr-readerMeta' }, doc.meta?.authors || ''),
                  React.createElement(
                    'div',
                    { className: 'dpr-readerBadges' },
                    React.createElement(
                      'span',
                      { className: 'dpr-readerBadge' },
                      doc.provenance?.mirrorKind === 'html'
                        ? 'HTML 版'
                        : (doc.meta?.pageCount || 0) + ' pages',
                    ),
                    React.createElement(
                      'span',
                      { className: 'dpr-readerBadge' },
                      t('reader.coverage') +
                        ' ' +
                        (Math.round((Number(doc.coverage?.characterRatio) || 0) * 10000) / 100) +
                        '%',
                    ),
                    React.createElement(
                      'label',
                      { className: 'dpr-readerBadge dpr-versionField' },
                      '版本 ',
                      React.createElement(
                        'select',
                        {
                          className: 'dpr-versionSelect',
                          value: doc.version?.kind || 'unknown',
                          onChange: (event) => void saveVersion(event.target.value),
                        },
                        React.createElement('option', { value: 'unknown' }, t('reader.versionUnknown')),
                        React.createElement('option', { value: 'vor' }, '正式版 VOR'),
                        React.createElement('option', { value: 'accepted' }, '录用稿'),
                        React.createElement('option', { value: 'preprint' }, '预印本'),
                      ),
                    ),
                    doc.meta?.doi
                      ? React.createElement('span', { className: 'dpr-readerBadge' }, 'DOI ' + doc.meta.doi)
                      : null,
                    doc.meta?.license
                      ? React.createElement('span', { className: 'dpr-readerBadge' }, doc.meta.license)
                      : null,
                  ),
                  doc.meta?.abstract
                    ? React.createElement(
                        'section',
                        {
                          id: '__meta_abstract',
                          className: 'dpr-readerAbstract',
                          'data-block-id': '__meta_abstract',
                          'data-page': 1,
                          'data-section': 'Abstract',
                          'data-source-text': doc.meta.abstract,
                        },
                        langMode === 'bilingual' && translatedMeta?.abstractSegments?.length
                          ? React.createElement(
                              'div',
                              { className: 'dpr-biBlock' },
                              translatedMeta.abstractSegments.map((segment, index) =>
                                React.createElement(
                                  'span',
                                  { className: 'dpr-biPair', key: 'abs' + index },
                                  React.createElement('span', { className: 'dpr-biSource' }, segment.source),
                                  React.createElement(
                                    'span',
                                    { className: 'dpr-biTarget' },
                                    segment.target || '（这一段还没有译文）',
                                  ),
                                ),
                              ),
                            )
                          : React.createElement(
                              'p',
                              { className: 'dpr-readerP' },
                              langMode === 'zh' && translatedMeta?.abstract
                                ? translatedMeta.abstract
                                : doc.meta.abstract,
                            ),
                        bubbleFor({ id: '__meta_abstract' }),
                      )
                    : null,
                  doc.meta?.keywords
                    ? React.createElement(
                        'p',
                        { className: 'dpr-readerMeta' },
                        React.createElement('strong', null, t('reader.keywords') + '：'),
                        doc.meta.keywords,
                      )
                    : null,
                  blocks.length > 0
                    ? blocks
                    : React.createElement('p', { className: 'dpr-sub' }, t('reader.noDoc')),
                  ),
                )
              : null,
          ),
          selection
            ? React.createElement(
                'div',
                { className: 'dpr-selectionBar', style: { visibility: barReady ? 'visible' : 'hidden' }, ref: barRef },
                React.createElement('textarea', {
                  value: draftQuestion,
                  'aria-label': '批注问题',
                  placeholder: t('reader.askPlaceholder'),
                  onChange: (event) => setDraftQuestion(event.target.value),
                }),
                React.createElement(
                  'div',
                  { className: 'dpr-selectionActions' },
                  React.createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'dpr-selectionBtn is-secondary',
                      disabled: selection.segments.length !== 1 || selection.quote.length > 160,
                      title:
                        selection.segments.length !== 1 || selection.quote.length > 160
                          ? '请只选择一个词、缩写或短短语'
                          : '解释这个词在当前论文语境中的含义',
                      onClick: () => void requestTermLookup(),
                    },
                    '查词',
                  ),
                  React.createElement(
                    'button',
                    { type: 'button', className: 'dpr-selectionBtn', onClick: addToChat },
                    t('reader.ask'),
                  ),
                  React.createElement(
                    'span',
                    { className: 'dpr-selectionHint' },
                    selection.segments.length > 1
                      ? selection.segments.length + ' 段一起问'
                      : t('reader.askHint'),
                  ),
                ),
              )
            : null,
          termLookup
            ? React.createElement(TermLookupCard, {
                state: termLookup,
                onClose: () => setTermLookup(null),
                onRetry: termLookup.request
                  ? () => void requestTermLookup(termLookup.request)
                  : undefined,
                onLocate: locateTermBlock,
              })
            : null,
          citationPreview
            ? React.createElement(CitationPreview, {
                state: citationPreview,
                onClose: () => setCitationPreview(null),
                onChoose: (number) => {
                  if (citationPreview?.block && citationPreview?.span) {
                    void startCitationPreview(citationPreview.block, citationPreview.span, number)
                  }
                },
                onChooseCandidate: (candidate) => {
                  void chooseCitationCandidate(candidate)
                },
                onRetry: () => {
                  if (citationPreview?.block && citationPreview?.span) {
                    void startCitationPreview(
                      citationPreview.block,
                      citationPreview.span,
                      citationPreview.number,
                      {
                        doi: citationPreview.reference?.doi || '',
                        arxiv: citationPreview.reference?.arxiv || '',
                        title: citationPreview.reference?.title || '',
                        referenceText: citationPreview.reference?.text || '',
                      },
                    )
                  }
                },
                onOpenLookup: openCitationLookup,
              })
            : null,
          sourcePagePreview > 0
            ? React.createElement(SourcePageDialog, {
                jobId,
                page: sourcePagePreview,
                pageCount: doc?.meta?.pageCount,
                onPage: (page) => setSourcePagePreview(page),
                onClose: () => setSourcePagePreview(0),
                t,
              })
            : null,
          glossaryOpen
            ? React.createElement(GlossaryDialog, {
                entries: glossaryEntries,
                saving: glossarySaving,
                error: glossaryError,
                onClose: () => setGlossaryOpen(false),
                onSave: saveGlossary,
              })
            : null,
          reviewPanelOpen
            ? React.createElement(ReviewDialog, {
                issues: reviewIssues,
                onLocate: locateReviewIssue,
                onRerun: () => void startReview(true),
                onClose: () => setReviewPanelOpen(false),
              })
            : null,
        ),
      )
    }

    //#endregion

    //#region 注册：页签类型 + 正文

    /**
     * 主界面类型声明（静态面；正文在 sidebar.right.pane.tab 里另注册）。
     * @param {(key: string) => string} t - 绑定到本命名空间的翻译函数。
     * @returns {object} 页签类型定义。
     */
    function homeType(t) {
      return {
        id: HOME_ID,
        kind: HOME_KIND,
        // 不给 patterns：这是“按 kind 打开”的页类型，不认领任何 dsh-resource 地址。
        title: () => t('type.home'),
        guide: [
          {
            id: 'start',
            order: 40,
            title: () => t('guide.title'),
            description: () => t('guide.description'),
            icon: PluginIcon,
          },
        ],
      }
    }

    /**
     * 路径页类型声明。
     * @param {(key: string) => string} t - 翻译函数。
     * @param {object} path - 路径描述（见 PATHS）。
     * @returns {object} 页签类型定义。
     */
    function pathType(t, path) {
      return {
        id: PATH_ID_PREFIX + path.id,
        kind: path.kind,
        title: () => t(path.titleKey),
      }
    }

    /**
     * 阅读页类型声明（由抄写完成按钮打开，jobId 放在 navigation.params 里）。
     * @param {(key: string) => string} t - 翻译函数。
     * @returns {object} 页签类型定义。
     */
    function readerType(t) {
      return {
        id: READER_ID,
        kind: READER_KIND,
        // 引用链接走 dsh-resource://doraemon-paper/<jobId>/<blockId>，
        // 由聊天里的 Markdown 链接交给右侧阅读页签，并滚动/高亮对应块。
        patterns: [
          'dsh-resource://doraemon-paper/**',
          'dsh-resource://file/**/*.dprcite',
          'dsh-resource://file/**/doraemon-paper-cites/**/*.dprcite',
          'dsh-resource://file/session/*/work/doraemon-paper-cites/*/*.dprcite',
          '**/*.dprcite',
        ],
        title: () => t('reader.title'),
      }
    }

    /**
     * 多篇综述选择页类型：没有 dsh-resource 认领，只负责选论文。
     * @param {(key: string) => string} t - 翻译函数。
     * @returns {object} 页签类型定义。
     */
    function surveyType(t) {
      return {
        id: SURVEY_ID,
        kind: SURVEY_KIND,
        title: () => t('home.surveyTitle'),
      }
    }

    function apply(ctx) {
      ctx.effect(
        () => ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN }),
        'dsh-doraemon-paper-reader: dictionaries',
      )
      const t = ctx.locale.bind(NS)

      ctx.effect(
        () => {
          if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
          const pluginPaneAt = (event) => {
            const direct = event.target instanceof Element
              ? event.target.closest('.dpr-pane')
              : null
            if (direct) return direct
            const x = Number(event.clientX)
            const y = Number(event.clientY)
            if (!Number.isFinite(x) || !Number.isFinite(y)) return null
            return [...document.querySelectorAll('.dpr-pane')].find((element) => {
              const rect = element.getBoundingClientRect()
              return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
            }) || null
          }
          const stop = (event) => {
            event.preventDefault()
            event.stopImmediatePropagation()
          }
          const onDragEnter = (event) => {
            if (pluginPaneAt(event)) stop(event)
          }
          const onDragOver = (event) => {
            const pane = pluginPaneAt(event)
            if (!pane) return
            const drop = event.target instanceof Element ? event.target.closest('.dpr-drop') : null
            if (!drop) stop(event)
          }
          const onDrop = (event) => {
            const pane = pluginPaneAt(event)
            if (!pane) return
            const drop = event.target instanceof Element ? event.target.closest('.dpr-drop') : null
            if (!drop) stop(event)
          }
          window.addEventListener('dragenter', onDragEnter, true)
          window.addEventListener('dragover', onDragOver, true)
          window.addEventListener('drop', onDrop, true)
          return () => {
            window.removeEventListener('dragenter', onDragEnter, true)
            window.removeEventListener('dragover', onDragOver, true)
            window.removeEventListener('drop', onDrop, true)
          }
        },
        'dsh-doraemon-paper-reader: drag boundary',
      )

      const sendPrompt = async (text, sessionIdArg) => {
        // 批注条按会话渲染，优先用它自己的 sessionId；阅读页调用时再回退到右栏挂载的会话。
        const sessionId = sessionIdArg || ctx.sidebarRight?.mounted?.getSnapshot?.()
        if (!sessionId) throw new Error(t('reader.askNoSession'))
        const scope = ctx.sessions?.scope?.(sessionId)
        const session = scope ? ctx.sessions.sessionOf(scope) : undefined
        if (!session) throw new Error(t('reader.askNoSession'))
        const outcome = await ctx.conversation.sendSession(session, text, [], 'queue')
        if (outcome.kind !== 'success') throw new Error(outcome.text || t('reader.askFailed'))
      }

      /**
       * 把批注摘要写回主输入框并触发送出；批注条不再有独立的「发送批注」。
       * @param {string} text - 已由宿主生成的用户消息正文。
       * @param {string} sessionIdArg - 批注条所在会话。
       * @returns {Promise<void>} 提交动作已交给宿主输入机。
       */
      const submitDraft = async (text, sessionIdArg) => {
        const sessionId = sessionIdArg || ctx.sidebarRight?.mounted?.getSnapshot?.()
        if (!sessionId) throw new Error(t('reader.askNoSession'))
        const scope = ctx.sessions?.scope?.(sessionId)
        if (!scope) throw new Error(t('reader.askNoSession'))
        const shell = ctx.conversation?.input?.for?.(scope)
        if (!shell) throw new Error('主输入框还没准备好，稍后再试。')
        shell.setDraft(text)
        // 让输入机先看到新草稿，再走宿主自己的发送流程。
        await new Promise((resolve) => setTimeout(resolve, 0))
        shell.submit()
      }

      /**
       * 对照视图里点 blockId 时回阅读页；对照层先关掉，避免盖住刚打开的阅读页。
       * @param {string} jobId - 作业 id。
       * @param {string} [blockId] - 要定位的块。
       */
      const openReader = (jobId, blockId) => {
        try {
          ctx.sidebarRight?.openTab?.(READER_KIND, {
            params: { jobId, ...(blockId ? { blockId } : {}) },
          })
        } catch (error) {
          console.warn('[doraemon-paper-reader] 打开阅读页失败：', error)
        }
      }

      ctx.effect(
        () => ctx.sidebarRightTabs.register(homeType(t)),
        'dsh-doraemon-paper-reader: home tab type',
      )
      for (const path of PATHS) {
        ctx.effect(
          () => ctx.sidebarRightTabs.register(pathType(t, path)),
          'dsh-doraemon-paper-reader: ' + path.id + ' tab type',
        )
      }
      ctx.effect(
        () => ctx.sidebarRightTabs.register(readerType(t)),
        'dsh-doraemon-paper-reader: reader tab type',
      )
      ctx.effect(
        () => ctx.sidebarRightTabs.register(surveyType(t)),
        'dsh-doraemon-paper-reader: survey tab type',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab', key: HOME_ID, locale: NS }, HomeBody),
          ),
        'dsh-doraemon-paper-reader: home tab body',
      )
      for (const path of PATHS) {
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.right.pane.tab',
                  key: PATH_ID_PREFIX + path.id,
                  locale: NS,
                  inject: () => ({ path: path }),
                  ...(path.id === 'file' ? { keepMounted: true } : {}),
                },
                path.id === 'file' ? FileImportBody : path.id === 'lookup' ? LookupBody : PathBody,
              ),
            ),
          'dsh-doraemon-paper-reader: ' + path.id + ' tab body',
        )
      }
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab', key: SURVEY_ID, locale: NS }, SurveyBody),
          ),
        'dsh-doraemon-paper-reader: survey tab body',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: READER_ID,
                locale: NS,
                inject: () => ({ sendPrompt }),
              },
              ReaderBody,
            ),
          ),
        'dsh-doraemon-paper-reader: reader tab body',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register(
              {
                name: 'shell.overlay',
                id: COMPARE_ID,
                locale: NS,
                inject: () => ({ submitDraft, openReader }),
              },
              CompareOverlay,
            ),
          ),
        'dsh-doraemon-paper-reader: comparison overlay',
      )
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.input.dock', () =>
            ctx.slots.register(
              {
                name: 'conversation.input.dock',
                id: 'doraemon-annotations',
                order: 10,
                locale: NS,
                inject: () => ({ sendPrompt, submitDraft }),
              },
              ComposerAnnotations,
            ),
          ),
        'dsh-doraemon-paper-reader: annotation composer dock',
      )
    }

    //#endregion

    return {
      inject: ['slots', 'sidebarRightTabs', 'locale', 'sidebarRight', 'sessions', 'conversation'],
      apply: apply,
      // 给 L0 测试用的内部出口；运行时没人读它（见 test/client.test.mjs）。
      __testables: {
        NS: NS,
        HOME_KIND: HOME_KIND,
        LOOKUP_KIND: LOOKUP_KIND,
        HOME_ID: HOME_ID,
        PATH_ID_PREFIX: PATH_ID_PREFIX,
        READER_KIND: READER_KIND,
        READER_ID: READER_ID,
        SURVEY_KIND: SURVEY_KIND,
        SURVEY_ID: SURVEY_ID,
        COMPARE_ID: COMPARE_ID,
        JOB_STORAGE_KEY: JOB_STORAGE_KEY,
        STAGE_ORDER: STAGE_ORDER,
        PATHS: PATHS,
        PALETTE: PALETTE,
        MASCOT_ASSETS: MASCOT_ASSETS,
        MASCOT_SRC: MASCOT_SRC,
        MASCOT_SPRITES: MASCOT_SPRITES,
        PROP_ASSETS: PROP_ASSETS,
        ICON_DOC: ICON_DOC,
        ICON_QUERY: ICON_QUERY,
        DICT_ZH: DICT_ZH,
        DICT_EN: DICT_EN,
        runs: runs,
        isPdfFile: isPdfFile,
        formatBytes: formatBytes,
        formatDuration: formatDuration,
        stageState: stageState,
        createAnnotationStore: createAnnotationStore,
        annotationStore: annotationStore,
        createComparisonStore: createComparisonStore,
        comparisonStore: comparisonStore,
        compareChatKey: compareChatKey,
        buildLogicArtifact: buildLogicArtifact,
        buildStructureArtifact: buildStructureArtifact,
        buildCoverageArtifact: buildCoverageArtifact,
        tableToMarkdown: tableToMarkdown,
        applyTableEdits: applyTableEdits,
        buildCompareReport: buildCompareReport,
        parseRotatedTableText: parseRotatedTableText,
        renderMarkdown: renderMarkdown,
        artifactIcon: artifactIcon,
        buildContextPacket: buildContextPacket,
        parseReaderAddress: parseReaderAddress,
        splitCitationText: splitCitationText,
        citationStanceLabel: citationStanceLabel,
        citationLookupParams: citationLookupParams,
        mascotArt: mascotArt,
        mascotSprite: mascotSprite,
        SourcePageDialog: SourcePageDialog,
        HomeBody: HomeBody,
        PathBody: PathBody,
        FileImportBody: FileImportBody,
        LoadingPanel: LoadingPanel,
        TermLookupCard: TermLookupCard,
        MaintenanceDialog: MaintenanceDialog,
        ReaderBody: ReaderBody,
        SurveyBody: SurveyBody,
        CompareOverlay: CompareOverlay,
        PaperPane: PaperPane,
        CompareWorkspace: CompareWorkspace,
        CompareArtifactWindow: CompareArtifactWindow,
      },
    }
  },
})

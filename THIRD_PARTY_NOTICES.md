<!-- 状态：✅有效 | 最后核对：2026-10-20 | 取代：无 -->

# 第三方代码与素材来源登记

> 规则见 [`AGENTS.md`](AGENTS.md) §2.2 与 §4 第 6 条：**照搬底层实现可以，但要留痕并做适配性改造**。
> 每复制一次，就在下表追加一行；同时保留对方许可证要求的版权声明正文。

## 1. 已复制（本项目实际用了的代码/素材）

| 日期 | 来源（仓库 / 文件） | 许可 | 用在哪 | 我们改了什么 |
|---|---|---|---|---|
| 2026-10-16 | **主形象插画**（素材，非代码）：项目自出图，生成链见 `docs/决定台账.md` D-017 / D-018 / D-019；**参考图由用户提供、属第三方，不入库、不随包发布** | 生成物归项目使用（阿里云百炼 DashScope `wan2.7-image-pro`，按该服务条款）；角色造型为本项目原创，未复制受保护角色（`docs/界面风格-v0.md` §5.7） | `assets/mascot/mascot-hello-smile-c.webp`（主界面与路径页插画，由宿主路由 `/doraemon-paper-reader/assets/*` 发出） | 只做尺寸与格式转换：`UI/mascot-v1.png`（2048×2048）→ 512×512 WebP，命令 `python 工具/export-asset.py UI/mascot-v1.png assets/mascot/mascot-hello-smile-c.webp --size 512`；**未改角色造型**。源图 5 MB 不进仓库 |
| 2026-10-21 | **动作角色、补充角色与小物件**（素材，非代码）：项目自出图，生成链见 D-079～D-083；角色参考图由用户提供、**不入库、不随包发布** | 生成物归项目使用（DashScope `wan2.7-image-pro`，按该服务条款）；透明提取与尺寸/精灵图导出为本地处理；角色造型与道具为本项目原创 | `assets/mascot/action-v1/`（7 状态 + 2 精灵图）、`assets/mascot/remaining-v1/`（6 状态）、`assets/props/v1/`（15 物件） | 源图经 BiRefNet 透明化，导出 512px/256px WebP 与横向精灵图；不改角色身份、不把 1024px 源图或生成工作流打进发布包。运行时由 `/doraemon-paper-reader/assets/*` 发出 |
| 2026-10-20 | [`KaTeX`](https://github.com/KaTeX/KaTeX) **v0.19.0**（npm `katex@0.19.0`，tarball shasum `b69c8cbcfc8c331be3f4f6e606b02b7146501ec7`） | **MIT** | `assets/vendor/katex/`：`katex.min.js`、`katex.min.css`、`fonts/*.woff2`；浏览器半区按需加载，用于论文栏公式排版 | **未改源码**；只做静态资产裁剪（只保留 min.js/min.css/fonts 的 woff2）并由宿主 `/doraemon-paper-reader/vendor/katex/*` 白名单路由发出。许可证原文：`assets/vendor/katex/LICENSE` |

### 1.1 PDF 提取原型使用的依赖（未复制其源码）

| 日期 | 来源 | 许可 | 用在哪 | 备注 |
|---|---|---|---|---|
| 2026-10-19 | [`jsvine/pdfplumber`](https://github.com/jsvine/pdfplumber) | MIT | `工具/pdf-pipeline/extract_pdf.py`：字符/行/线框/表格读取 | 作为 Python 依赖调用，未把源码复制进仓库 |
| 2026-10-19 | [`pypdfium2-team/pypdfium2`](https://github.com/pypdfium2-team/pypdfium2) | Apache-2.0（PDFium 为 BSD-3-Clause） | 页面渲染与图/表/公式区域裁剪 | 同上 |
| 2026-10-19 | [`python-pillow/Pillow`](https://github.com/python-pillow/Pillow) | MIT-CMU | 裁剪图读写 | 同上 |
| 2026-10-19 | `paper-translation` 技能（`C:\Users\Lenovo\.codex\skills\paper-translation`，MIT） | MIT | 只参考“块抽取 → 覆盖率台账 → 区域裁剪 → 渲染核对”的流程与失败边界 | **未复制代码**；原型用 pdfplumber 重写了提取，且刻意避开其 PyMuPDF（AGPL）依赖 |

## 2. 候选源与许可状态（复制前先查这张表）

| 来源 | 许可 | 能否复制 | 备注 |
|---|---|---|---|
| [`GGboya/dsh-paper-reader`](https://github.com/GGboya/dsh-paper-reader) | MIT | ✅ 可复制 | 保留版权声明；注意它的阅读器是独立 iframe 页，接口需按我们的协议改造 |
| `paper-translation` 技能（`C:\Users\Lenovo\.codex\skills\paper-translation`，作者 Micraow 等） | MIT | ✅ 可复制 | 覆盖率台账 / 块抽取 / 区域裁剪 / 引用重建 的算法可直接搬；它依赖 PyMuPDF，是否引入由 Q17 决定 |
| [`omdsh-dev/dsh-annotation`](https://github.com/omdsh-dev/dsh-annotation) | MIT | ✅ 可复制 | 批注锚点与浮层交互细节可搬；它不含 PDF 场景 |
| [`yfwu2020/dsh-selection-explain`](https://github.com/yfwu2020/dsh-selection-explain) | MIT | ✅ 可复制 | 划词浮层与流式渲染细节可搬；**不要搬它注入 DSH 主 DOM 的那套选择器策略**（与我们的阅读器形态不同） |
| [`1692775560/dsh-Mimir-Academic-research`](https://github.com/1692775560/dsh-Mimir-Academic-research) | MIT | ✅ 可复制 | 体量大，按需取用（arXiv 元数据、证据链部分） |
| `dsh-word-vault` | MIT | ✅ 可复制 | 生词库与朗读实现可搬（Windows SAPI 离线发音） |
| 官方 `deepseek-ai/deepseek-harness` | MIT | ✅ 可引用/复制 | 但它同时是我们的**运行时**：优先用官方 API，不要拷内部实现 |
| `smilewhenever777/dsh-scholar` | **无许可证** | ⛔ **不可复制** | 无许可 = 保留所有权利；**连文本都不搬**（思想可参考） |
| `@huanlin/dsh-plugin-better-locale` | **AGPL-3.0** | ⛔ **不可复制** | AGPL 传染性许可，只能读原理 |
| `docling-project/docling` | MIT | ✅ 可复制（模型/权重需单独核对） | 版面、阅读顺序、表格、公式的统一文档模型；可作为后续受管 Python sidecar 候选 |
| `datalab-to/marker` | 代码 Apache-2.0；模型权重 OpenRAIL-M | ⚠️ 代码可复制，权重不可直接随包分发 | PDF→Markdown/JSON/HTML 的成熟实现；商用/分发前核对权重条款 |
| `grobidOrg/grobid` | Apache-2.0 | ✅ 可复制/可调用 | 学术 PDF 的 TEI/XML 结构、引用解析；Java 服务较重 |
| `allenai/pdffigures2` | Apache-2.0 | ✅ 可复制/可调用 | 图表、题注、章节标题提取；可作为图注定位对照 |
| `opendatalab/MinerU` | GitHub 元数据 `NOASSERTION`，需核对 LICENSE | ⚠️ 保守处理，未核对前不复制 | 解析能力强，但依赖/模型边界复杂 |
| `PDFMathTranslate/PDFMathTranslate`、`funstory-ai/BabelDOC` | AGPL-3.0 | ⛔ 不可复制 | 只能读原理；与我们的 MIT 运行时隔离 |
| `pymupdf/PyMuPDF` | AGPL-3.0（或商业许可） | ⛔ 不引入运行时 | `paper-translation` 技能用它；本原型改用 pdfplumber/pypdfium2 |

> 复制前若发现上表没有的来源，**先查它的 LICENSE 再决定**；查不到许可证就当"不可复制"处理。

## 3. 许可证原文（按需附上）

复制了某个源的代码后，在这里附上它 LICENSE 的正文（或指向仓库内 `licenses/<源名>-LICENSE.txt` 的路径）+ 我们复制时的 commit/版本号。

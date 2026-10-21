# PDF → MirrorDoc → HTML 原型

这是阅读器路线的第一个可行性切片：先把 PDF 的**文本、位置戳、图、表、公式**拆出来，
生成 `MirrorDoc`，再排成一个可阅读的 HTML 页面。它不接 DSH、不翻译，也不改原 PDF；
目的是回答一个问题：**“PDF 提取 + 分类 + 重排成 HTML”能不能作为后续阅读器的基础。**

## 运行

依赖都在 Python 侧，均为宽松许可：

```powershell
python -m pip install pdfplumber pypdfium2 Pillow

python 工具/pdf-pipeline/extract_pdf.py `
  "D:\振动传感器\物流\sensors-22-04003.pdf" `
  --out "工具/gen/pdf-html-spike-20261019/pipeline" `
  --dpi 200 --progress

python 工具/pdf-pipeline/reconcile_layout.py `
  "工具/gen/pdf-html-spike-20261019/pipeline" --progress

python 工具/pdf-pipeline/render_html.py `
  "工具/gen/pdf-html-spike-20261019/pipeline/mirrordoc.json" `
  --out "工具/gen/pdf-html-spike-20261019/pipeline/paper.html"
```

`--progress` 会把 `read / classify / assets / crop / pages / mirror / verify / done` 阶段写到 stderr；
DSH 宿主 `src/papers.js` 解析这些行，显示在 PDF 导入页的加载面板里。

截图（系统 Edge，需 `playwright-core`，不下载浏览器内核）：

```powershell
$env:DPR_PLAYWRIGHT='D:\DSH-Plugins\_dpr-e2e-tools\node_modules\playwright-core\index.js'
node 工具/pdf-pipeline/screenshot.mjs `
  "工具/gen/pdf-html-spike-20261019/pipeline/paper.html" `
  "工具/gen/pdf-html-spike-20261019/shots"
```

六篇异形论文的真实回归（Sensors / Plague / PLOS / AIoT，以及本地存在时自动加入的 IoT 算法型 / Twitter 多表综述）：

```powershell
npm run test:pdf-regression
```

每篇回归在 `extract + reconcile` 后自动运行确定性结构审计。也可以对任意 job 单独跑：

```powershell
npm run audit:pdf -- <job-dir> --out <audit-dir>
npm run audit:pdf -- <after-dir> --out <audit-dir> --baseline <before-audit.json>
```

审计输出 `audit-report.json` / `audit-report.md`，规则覆盖页眉污染、假标题、Abstract、
算法控制流、段落断裂、连字符、参考文献、表格裁剪/文字行边界和报告新鲜度。报告带
`scopeLimits`；`0 findings` 只表示确定性结构范围通过，不代表中文语义或单元格结构已通过。

## 产物

`extract_pdf.py --out <dir>` 写出：

| 文件 | 内容 |
|---|---|
| `mirrordoc.json` | 统一内容模型：meta / version / outline / blocks / assets / coverage |
| `paper-summary.json` | 供提问复用的精简原文概要：摘要、章节 gist、图表公式题注、参考文献数 |
| `lines.json` | 每一行文本的位置戳、字号、字体、角色、栏位 |
| `assets.json` | 图/表/公式的页码、bbox、题注、裁剪图路径 |
| `assets/*.png` | 从原页裁剪的图、表、公式 |
| `source-pages/*.png` | 原版页渲染，供“原版 p.N”核对 |
| `report.md` | 本次提取的页数、覆盖率、块类型、资产数量 |
| `layout-report.json` | 表格裁剪图与原页 bbox 的长宽比/像素差/空白检查 |
| `audit/layout-audit.png` | 每个表格的“原页裁剪 vs 阅读器裁剪”并排视觉复核 |

## 当前样本结果

样本：`Sensors 2022, 22, 4003`（21 页，A4，单栏＋首页左侧元数据栏；CC BY 4.0）。

| 指标 | 结果 |
|---|---|
| 页数 | 21 |
| 源文本行 | 641 |
| MirrorDoc 块 | 94 |
| 正文源行分配率 | **100%**（597/597；未分配 0） |
| 整页字符占比 | 96.38%（其余是页眉/页脚与首页左侧引用/版权栏，按设计不进入正文） |
| 图 | 15（与样本工程台账一致） |
| 表 | 3（与样本工程台账一致） |
| 编号公式 | 4 个；相邻的 (3)/(4) 合并为一张裁剪，因此 3 张公式图 |
| 参考文献 | 34 条（与样本工程台账一致） |
| 提取耗时 | 约 6–7 秒（含 200 DPI 裁剪，不含截图） |
| 图片加载 | 21/21 成功，浏览器 console 0 error |
| L0 单测 | Python PDF 管线 62/62；Node 171/171 |
| 回归 | 6/6 selected `ok:true`；所有样本无结构 error，孤立图注以 warning 保留（D-090） |

样本 PDF 与裁剪图只放在 `工具/gen/`（已被 `.gitignore` 忽略），不随插件发布。

## 这套原型实际做了什么

1. **字符级重建**：源 PDF 的文本层没有空格；按字符 `x0/x1` 的间距阈值补空格。
2. **重复字形去重**：该 PDF 会为同一个 `ﬁ` 连字输出两个同位置字形，先去重再展开，
   避免 `deﬁﬁned → defifined`。
3. **分栏感知**：首页左侧是引用/版权栏，右侧是正文；先找持续存在的垂直空白带，
   再把字符按栏分组，避免左右栏按同一 y 坐标串成一行。
4. **行/段/章节分类**：标题、作者/机构、摘要、关键词、章节标题、正文、题注、公式、
   参考文献分别打角色；题注续行按小写开头＋行距＋同 x0 判断，避免吞掉表体。
5. **图表定位**：图用“题注上方的图像簇”定位；整页多面板图用“上一张图的题注到本题注”
   的垂直窗口合并；表用题注下方的水平线定位；公式按编号行定位。
6. **位置戳**：每个块保留 `page`、`bbox`、`sourceIds`；裁剪资产保留 `page`、`bbox`、
   `caption`，HTML 里可点“原版 p.N”回看原页。
7. **覆盖台账**：按 `sourceIds` 计算每个正文源行是否被块或裁剪资产接住，未接住的会
   列在 `coverage.unassignedLines`，不静默丢内容。

## 当前边界

- **公式 LaTeX / 表格单元格译文已接入宿主阅读页**（D-049）；低置信度公式需手动修正，表格数字校验不过时只保留原表。
- **整页旋转密集表**会先压缩再按 8% 重叠纵向切片重试；仍失败时明确降级为原表，不做猜测（D-050）。
- **扫描件没有 OCR**；当前依赖文本层。
- **跨页段落**按页断开；后续可按章节合并。
- **双栏/多栏**只做了首页侧栏与简单垂直空白带检测；复杂三栏、跨栏图表需要更完整的版面模型。
- **题注续行**是启发式；下一版应结合字号、缩进、题注编号与图表 bbox 一起判。
- **HTML 阅读器**尚未接入 DSH 页签、选区、批注、引用蓝链和原版 PDF 内嵌视图。

## 参考与许可

- `paper-translation` 技能（MIT）：参考其“块抽取 → 覆盖率台账 → 区域裁剪 → 渲染核对”
  的流程与失败边界；本原型的代码是重写的，未复制其 PyMuPDF 实现。
- `pdfplumber`（MIT）：文本、字符、线框、表格。
- `pypdfium2`（Apache-2.0）/ PDFium（BSD-3-Clause）：页面渲染与区域裁剪。
- `Pillow`（MIT-CMU）：图片读写。

研究过但**没有作为运行时依赖**的候选：

- `docling-project/docling`（MIT）：版面/阅读顺序/表格/公式的统一文档模型；可作为后续
  受管 Python sidecar 的候选。
- `datalab-to/marker`（代码 Apache-2.0，模型权重 OpenRAIL-M）：PDF→Markdown/JSON/HTML
  的成熟实现；模型权重有商用门槛，不能直接随插件分发。
- `grobidOrg/grobid`（Apache-2.0）：学术 PDF 的 TEI/XML 结构抽取与引用解析；适合做
  结构对照，但需要 Java 服务。
- `allenai/pdffigures2`（Apache-2.0）：图表/题注/章节标题提取，适合对照图注定位。
- `opendatalab/MinerU`、`PDFMathTranslate`、`BabelDOC`：能力很强，但许可与模型/权重
  边界需要单独核对；按本项目 D-014 的保守口径，不作为可直接复制源。


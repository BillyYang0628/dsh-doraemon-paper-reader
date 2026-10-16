<!-- 状态：✅有效 | 最后核对：2026-10-16 | 取代：无 -->

# 第三方代码与素材来源登记

> 规则见 [`AGENTS.md`](AGENTS.md) §2.2 与 §4 第 6 条：**照搬底层实现可以，但要留痕并做适配性改造**。
> 每复制一次，就在下表追加一行；同时保留对方许可证要求的版权声明正文。

## 1. 已复制（本项目实际用了的代码/素材）

| 日期 | 来源（仓库 / 文件） | 许可 | 用在哪 | 我们改了什么 |
|---|---|---|---|---|
| — | （暂无） | — | — | — |

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

> 复制前若发现上表没有的来源，**先查它的 LICENSE 再决定**；查不到许可证就当"不可复制"处理。

## 3. 许可证原文（按需附上）

复制了某个源的代码后，在这里附上它 LICENSE 的正文（或指向仓库内 `licenses/<源名>-LICENSE.txt` 的路径）+ 我们复制时的 commit/版本号。

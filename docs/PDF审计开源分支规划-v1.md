<!-- 状态：✅有效 | 最后核对：2026-10-22 | 取代：无 -->

# PDF 审计开源分支规划 v1

## 1. 定位

当前仓库 `dsh-doraemon-paper-reader` 首先是一个 DSH 插件。PDF 审计流具有独立复用价值，未来可作为同一 GitHub 仓库的公开维护分支，而不是把审计工具绑死在插件 UI 中。

计划分支名：

```text
audit-lab
```

本轮只记录规划，不实际创建或推送分支。

## 2. 分支目标

让用户用自己的 PDF 复现：

```text
PDF
→ extract/reconcile
→ 确定性结构审计
→ before/after 差分
→ 可选本地回归
→ 按 rule ID 修算法
→ 旧语料防退化
```

审计输出必须说明 `scopeLimits`，不能用 “0 findings” 宣称中文语义或单元格内容已经完全正确。

## 3. 分支应包含

- `工具/pdf-pipeline/`
- `docs/PDF审计实验*.md`
- `docs/PDF审计开源分支规划-v1.md`
- `test_pipeline.py`
- `regression_cases.json`
- `regression_check.py`
- 许可、requirements 和使用说明

插件运行代码、角色插画、DSH UI 资产不属于公共审计分支的必要内容。

## 4. 用户使用方式

```powershell
npm run setup:python
npm run test:pdf-regression
npm run audit:pdf -- <job-dir> --out <audit-dir>
npm run audit:pdf -- <after-dir> --out <audit-dir> --baseline <before-audit.json>
```

单独处理一篇新论文：

```powershell
python 工具/pdf-pipeline/extract_pdf.py paper.pdf --out work/paper/before --dpi 144
python 工具/pdf-pipeline/reconcile_layout.py work/paper/before
python 工具/pdf-pipeline/audit_structure.py work/paper/before --out work/paper/audit
```

## 5. 样本与许可

- 不把论文 PDF 大批提交到公开仓库；
- 本地样本放 ignored 的 `工具/gen/`；
- `regression_cases.json` 推荐继续使用 `optional + sourcePath`：样本存在则跑，clean checkout 缺样本时标记 skip；
- 公共 CI 应使用许可明确、体积受控的小型 fixture，或由用户通过 `--source name=/path` 提供；
- 不提交 DSH 作业目录、API key、用户批注或完整论文正文。

## 6. 质量门禁

- audit error 阻断；
- warning 保留并列出，不等于通过；
- 新 PDF 发现的问题必须先加入独立 audit case 或规则测试；
- 修算法后至少跑旧语料回归；
- 新算法必须避免“只修当前样本”的页名、刊名或固定坐标；
- 任何 before/after 结论都带 PDF SHA、页数、rule 数、未覆盖项。

## 7. 候选发布形态

优先：

1. 同一 GitHub 仓库的 `audit-lab` 分支；
2. `工具/pdf-pipeline` 独立 README / 示例；
3. 后续可拆成单独的 `dsh-pdf-structure-audit` CLI 包。

拆分包前先观察外部使用情况，避免现在把路径、文档和回归语料拆成两套事实源。

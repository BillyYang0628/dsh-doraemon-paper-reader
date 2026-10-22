<!-- 状态：✅有效 | 最后核对：2026-10-22 | 取代：无 -->

# PDF 审计开源分支规划 v1

## 1. 定位

当前仓库 `dsh-doraemon-paper-reader` 首先是一个 DSH 插件。PDF 审计流具有独立复用价值，
因此以同一 GitHub 仓库内的 `audit-lab/` 目录维护，并单独生成 audit-lab tgz，而不是把
审计工具绑死在插件 UI 中。

独立发布物：

```text
dist/dsh-doraemon-paper-reader-audit-lab-<version>.tgz
```

D-102 已落地目录、CLI、CI 和双包发布器。暂不另建 Git 分支，避免管线代码和回归事实源
出现两套。

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

## 5. 当前目录与独立包

仓库内：

```text
audit-lab/
  cli.mjs
  package.json
  cases/
  test/
  work/              # ignored
```

独立 tgz 额外包含：

```text
pdf-pipeline/        # 由工具/pdf-pipeline 暂存复制
docs/PDF审计*.md
LICENSE
THIRD_PARTY_NOTICES.md
```

独立包不含 `src/`、`assets/`、DSH bundle patch 或插件页签。

## 6. 样本与许可

- 不把论文 PDF 大批提交到公开仓库；
- 本地样本放 ignored 的 `工具/gen/`；
- `regression_cases.json` 推荐继续使用 `optional + sourcePath`：样本存在则跑，clean checkout 缺样本时标记 skip；
- 公共 CI 应使用许可明确、体积受控的小型 fixture，或由用户通过 `--source name=/path` 提供；
- 不提交 DSH 作业目录、API key、用户批注或完整论文正文。

## 7. 质量门禁

- audit error 阻断；
- warning 保留并列出，不等于通过；
- 新 PDF 发现的问题必须先加入独立 audit case 或规则测试；
- 修算法后至少跑旧语料回归；
- 新算法必须避免“只修当前样本”的页名、刊名或固定坐标；
- 任何 before/after 结论都带 PDF SHA、页数、rule 数、未覆盖项。

## 8. 发布形态

当前采用：

1. 同一 GitHub 仓库的 `audit-lab/` 目录；
2. 独立 audit-lab tgz；
3. 后续外部使用量足够时，再评估拆成单独的
   `dsh-pdf-structure-audit` npm CLI。

暂不把底层脚本复制成两套源码：发布器只做打包时暂存复制，仓库内仍以
`工具/pdf-pipeline/` 为单一事实源。

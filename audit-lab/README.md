# 大肥鱼 PDF 结构审计实验室

这是一个与 DSH 插件运行代码分离的本地审计工作区。它复用仓库中的 PDF
提取与结构审计工具，但输出、案例和迭代记录都留在 `audit-lab/`，不会修改论文、
插件数据目录或 DSH profile。

## 适合谁

- 想用自己的 PDF 检查标题、正文、表格、算法、公式、分隔线和参考文献结构的人；
- 想为某类论文增加审计规则、但不想改插件 UI 的人；
- 想先跑 before/after 差分，再把已验证的修复提交给插件仓库的人。

## 环境

- Node.js 22.19+ 或 24+
- Python 3.9+
- PDF 提取依赖由仓库受管环境或系统 Python 安装：

```powershell
npm run setup:python
```

## 快速开始

在仓库根目录运行：

```powershell
# 1) 检查审计工具和案例文件
npm run audit:lab -- self-check

# 2) 处理一篇本地论文：extract → reconcile → audit
npm run audit:lab -- extract .\my-paper.pdf --out .\audit-lab\work\my-paper

# 3) 对已有 MirrorDoc 作业重跑结构审计
npm run audit:lab -- audit .\audit-lab\work\my-paper

# 4) 运行固定语料回归
npm run audit:lab -- regression --keep-going

# 5) 把自己的 PDF 临时加入回归，不写死到公共案例
npm run audit:lab -- regression --source my-paper=C:\papers\my-paper.pdf --case my-paper
```

`extract` 默认把产物放在 `audit-lab/work/<文件名>-<时间>/`。也可以显式指定
`--out`。审计报告写在 `<输出目录>/structure-audit/`。

## 独立发布包

发布检查会同时生成：

```text
dist/dsh-doraemon-paper-reader-<version>.tgz
dist/dsh-doraemon-paper-reader-audit-lab-<version>.tgz
```

第一个是 DSH 插件安装包；第二个是独立审计实验室，不包含插件 UI、角色插画或
插件运行入口。两个包分别安装、分别升级。

## 迭代方法

1. 先保留修改前的审计报告；
2. 新建或修改 `audit-lab/cases/private/*.json`，不要把有版权的论文提交到仓库；
3. 运行新案例，确认问题真实存在并记录稳定 rule ID；
4. 修改 `工具/pdf-pipeline/audit_structure.py`、提取器或回归断言；
5. 跑 `python 工具/pdf-pipeline/test_pipeline.py` 和旧语料回归；
6. 用 `--baseline` 比较 before/after，确认没有把旧问题改成新问题；
7. 将可公开的最小案例、根因和验证结果写入 `docs/PDF审计实验*.md`。

只有规则测试和旧语料回归都通过，才把修改提交给插件仓库。`0 findings` 只表示
当前规则没有发现问题，不表示中文语义、表格单元格内容或论文事实已经正确。

## 隐私与许可

- 不提交付费墙论文、DSH 作业目录、API key、批注或完整论文正文；
- 默认忽略 `audit-lab/work/` 和 `audit-lab/cases/private/`；
- 公共案例只放元数据、预期结构和必要的开放许可小型 fixture；
- 论文处理结果必须保留来源、SHA-256、页数和未覆盖项。

## 目录

```text
cli.mjs                 extract / audit / regression / self-check
cases/                  公共案例说明与本地案例模板
cases/private/          用户私有案例（ignored）
test/                   CLI 自检
work/                   本地产物（ignored）
```

仓库内运行时，CLI 自动定位 `../工具/pdf-pipeline/`；独立发布包内运行时，
CLI 使用包内 `pdf-pipeline/`。两条路径都不依赖 `src/`。

# 审计案例

公共案例描述**结构预期**，不包含论文 PDF。默认回归清单在
`工具/pdf-pipeline/regression_cases.json`；用户案例放在 `cases/private/`，该目录
已被 Git 忽略。

从 [`local.example.json`](local.example.json) 复制一份私有案例：

```powershell
New-Item -ItemType Directory -Force .\audit-lab\cases\private
Copy-Item .\audit-lab\cases\local.example.json .\audit-lab\cases\private\my-paper.json
```

然后把 `sourcePath` 改成你的本地 PDF，运行：

```powershell
npm run audit:lab -- regression `
  --cases .\audit-lab\cases\private\my-paper.json `
  --out .\audit-lab\work\my-paper-regression
```

案例至少应记录：

- PDF SHA-256 或稳定来源；
- 标题、页数和语言；
- 关键块类型与最少数量；
- 必含文本、禁止文本；
- 章节顺序；
- 表格行列、表头或 continued-table 关系；
- 仍无法自动判断、需要人工看原文的 `scopeLimits`。

不要把“模型看起来正确”当作结构金标。能写成页码、blockId、文本、行列或坐标的
断言优先。

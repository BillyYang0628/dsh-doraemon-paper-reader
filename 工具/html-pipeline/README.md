# arXiv HTML → MirrorDoc

`extract_html.py` 把 arXiv/ar5iv 的结构化 HTML 转成阅读器使用的 `mirrordoc.json` + `paper-summary.json`。

- 输入只应是宿主已经取回并落盘的 arXiv/ar5iv 页面；
- 依赖 Python 标准库，不需要额外 pip 包；
- 识别 `ltx_section` / `ltx_figure` / `ltx_table` / `ltx_equation` / `ltx_bibitem`；
- 图片先记录为 `assetSource`，由宿主下载到 `assets/` 后再改写为本地 `asset`；
- HTML 没有物理页码，块 `page=0`，阅读页显示「HTML 版」。

```powershell
python 工具/html-pipeline/extract_html.py paper.html --out <jobDir> --base-url https://arxiv.org/html/<id> --progress
```

输出：

- `mirrordoc.json`：标题、作者、摘要、章节、图表公式、参考文献、覆盖率和 provenance；
- `paper-summary.json`：论文库/提问用的轻量摘要；
- `report.md`：块数、图数、字符覆盖率。

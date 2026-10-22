# 参与开发

这个仓库同时承载 DSH 插件、PDF 管线和独立审计实验室。开始开发前先读
`AGENTS.md`；新会话应同时加载项目级 `.dsh/skills/doraemon-dev-loop/SKILL.md`。

## 边界

- `src/`、`assets/`、`cordis.patch.yml` 是插件运行代码；
- `工具/pdf-pipeline/` 是 PDF 提取、复核和审计的共享工具；
- `audit-lab/` 是用户可独立运行的审计与迭代工作区，不属于插件安装包；
- `test/` 是插件和工具的 L0 回归；
- `docs/` 记录设计、决定、实验和发布证据。

插件的运行包必须保持自包含：不把第三方插件放进 `dependencies`，不 import
官方 client 包，不 monkey-patch 宿主 DOM。

## 最小开发回路

```powershell
npm run verify:offline

# 需要真实 PDF 语料时
npm run setup:python
npm run verify
```

界面改动还需要真实 DSH L2 证据。没有浏览器控制权时，只能报告“视觉验证不可用”，
不能用 mock 截图代替。

## 修改插件

1. 先写或找到能失败的测试；
2. 修改最小实现；
3. 跑 `npm test`；
4. 涉及 PDF 时加跑 `python 工具/pdf-pipeline/test_pipeline.py` 和
   `npm run test:pdf-regression`；
5. 涉及 UI 时附并排截图并将截图先压到预览尺寸；
6. 更新 `docs/决定台账.md` 和 `docs/项目索引.md`。

## 修改审计规则

审计实验不要直接拿插件 UI 代码当调试台：

```powershell
npm run audit:lab -- self-check
npm run audit:lab -- extract .\paper.pdf --out .\audit-lab\work\paper
npm run audit:lab -- regression --keep-going
```

新规则必须：

- 有稳定的 rule ID；
- 能说明是通用结构问题，不是只对当前样本硬编码；
- 有 before/after 报告；
- 跑旧案例防止退化；
- 明确 `scopeLimits`。

## 发布

```powershell
npm run verify
npm run package:release
```

发布时会生成插件包、独立 audit-lab 包、`RELEASE_NOTES-<version>.md`、
`release-manifest.json` 和 `SHA256SUMS.txt`。仓库有未提交改动时
`package:release` 会拒绝；本地预览可用：

```powershell
npm run package:candidate
```

不要手工编辑 `dist/` 中的包内容。发布前必须确认包内没有论文、截图、缓存、
`.env`、API key 或 DSH 作业目录。

## 提交

- 提交信息使用中文，一句话说明“改了什么、为什么”；
- 不包含 `Co-Authored-By`；
- 推送、创建 tag 和 GitHub Release 需要仓库 owner 明确授权。

# 安装、下载与调试

本文件只讲最短可执行路径。设计取舍见 `docs/搭建与发布.md`，硬约束见
`AGENTS.md`。

## 0. 选择你的使用方式

| 目标 | 推荐方式 | 产物 |
|---|---|---|
| 在 DSH 里日常使用 | 桌面端“插件 → 添加插件”，选择 tgz 或仓库目录 | `dist/dsh-doraemon-paper-reader-<version>.tgz` |
| 修改插件 UI、宿主逻辑或运行测试 | 克隆仓库，用 `link:` 装进开发 profile | Git 工作区 |
| 只迭代 PDF 结构审计 | 下载独立 audit-lab tgz | `dist/dsh-doraemon-paper-reader-audit-lab-<version>.tgz` |

插件包与审计实验室包分开。审计实验室不要求安装插件 UI，也不会写入 DSH
profile。

## 1. 前置条件

- DeepSeek Harness `0.2.0-rc.2` 到 `0.3.0` 之前；
- Node.js `22.19+` 或 `24+`；
- Python `3.9+`；首次处理 PDF 时插件会在
  `$DSH_HOME/doraemon-paper-reader/python-env/` 创建受管 venv；
- Windows、macOS、Linux 均可运行 Node 测试；当前真实 PDF 回归主要在 Windows
  本机验证。

插件没有 npm 运行时依赖，不需要在仓库里执行 `npm install`。

## 2. 全新 DSH：安装发布包

1. 从 GitHub Release 下载 `dsh-doraemon-paper-reader-<version>.tgz`；
2. 打开 DSH 桌面端 →「插件」→「添加插件」；
3. 选择 tgz 的绝对路径；
4. 安装后点「立即启用」；
5. 新开一个会话；若全新 DSH 显示预览版说明，点“继续”；
6. 若出现 API Key 引导，没有密钥时选“稍后配置”；插件本地页面仍可打开，但问答、
   翻译、图表解释等模型能力需要之后再配置模型；
7. 展开右侧边栏，应出现「论文阅读器」入口。

命令行安装到已初始化的 profile：

```powershell
dsh plugin --profile dev add D:\downloads\dsh-doraemon-paper-reader-0.2.0.tgz
```

不要把 tgz 解压后只复制 `src/`。插件的 `package.json`、`cordis.patch.yml`、
`assets/` 和 PDF/Python 管线条目必须一起安装。

## 3. 从源码安装并调试

```powershell
git clone <你的 GitHub 仓库地址> dsh-doraemon-paper-reader
cd dsh-doraemon-paper-reader

# 先跑不需要真实论文样本的测试
npm run verify:offline

# 用链接方式安装；改源码后重启 DSH 即可
dsh plugin --profile dev add link:<仓库绝对路径>
dsh --profile dev --no-open --port 3105
```

安装后：

- `src/*.js` 改动：重启 DSH profile；
- `src/client.js` 改动：没有前端构建步骤，重启或刷新页面即可；
- `package.json`、manifest 或 bundle patch 改动：重新执行 plugin add；
- `assets/` 改动：确认导出后的文件已经进入包清单。

## 4. Python 与首次 PDF

```powershell
npm run setup:python
```

也可以在插件的“环境与存储”页点击“准备/修复 Python 环境”。

首次 PDF 流程：

1. 打开「论文阅读器」→「PDF 文件」；
2. 选择或拖入 PDF；
3. 点击“大肥鱼给朕速速抄写！！！”；
4. 等待提取、版式复核和结构审计；
5. 完成后打开阅读页。

注意：`paper.html` 不再直接作为阅读页，插件使用 MirrorDoc 对应的阅读页签。

## 5. 数据与密钥

- 论文、批注、翻译和缓存都在 `$DSH_HOME/doraemon-paper-reader/`；
- 模型 API key 由 DSH 管理，插件不写入 `.env`，也不会把 key 打进发布包；
- 卸载插件不会删除论文和批注；
- 清理缓存只删除可重建的对照、引用、视觉和翻译缓存。

## 6. 验证安装

```powershell
npm run verify:offline
npm run verify
```

`verify:offline` 用于 GitHub CI，不要求本地真实论文；`verify` 额外运行本机
存在语料的 PDF 回归。没有相应样本时会明确跳过，不能把跳过写成通过。

浏览器验证入口：

```powershell
node 工具/e2e/main-interface.mjs --url <DSH URL>
node 工具/e2e/knowledge-center.mjs --url <DSH URL> --out 工具/gen/install-smoke
```

## 7. 升级与回滚

升级：

1. 保存当前 tgz；
2. 在插件页卸载当前版本；
3. 安装新 tgz；
4. 新开会话验证入口和已有论文；
5. 旧数据格式必须保持向后兼容。

回滚：

1. 卸载新版本；
2. 安装保存的旧 tgz；
3. 若旧版本无法读取新数据，不要覆盖原目录，先备份
   `$DSH_HOME/doraemon-paper-reader/`。

## 8. 常见问题

**能看到入口但 PDF 任务失败**

先检查“环境与存储”里的 Python 状态，再运行：

```powershell
python 工具/pdf-pipeline/test_pipeline.py
```

**插件加载失败**

确认安装的是完整包目录或 tgz，而不是单独的文件；确认 DSH 版本满足
`package.json` 的 `engines.dsh`。

**GitHub CI 通过但本机 PDF 回归失败**

GitHub CI 默认无私有论文样本，只跑离线测试。本机真实回归需要
`regression_cases.json` 中的 source 或 DSH 作业目录存在。

## 9. 自行迭代审计

不要把实验性规则直接改到插件运行代码中。先进入 [`audit-lab/README.md`](audit-lab/README.md)：

```powershell
npm run audit:lab -- self-check
npm run audit:lab -- extract .\paper.pdf --out .\audit-lab\work\paper
npm run audit:lab -- regression --keep-going
```

审计输出和私有案例与插件运行目录分离。通过旧语料回归后，再把修复整理成插件
仓库的 patch。

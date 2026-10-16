# 机器猫论文阅读器 · dsh-doraemon-paper-reader

DeepSeek Harness（DSH）插件：**论文精读工作台** —— 获取与镜像 · 中英对照阅读 · 引用蓝链 · 划词批注。

> 状态：**v0.0.1 骨架**（宿主半区可加载，工具/路由/阅读器页待实现）。
> 设计基线见 `DSH论文精读工作台-功能框架-v0.md` 的 §12 修订记录（R1）。

## 目录结构

```
docs/           设计文档（权威版本在仓库里）
  功能框架-v0.md  论文精读工作台的功能框架基线（含 §12 修订记录 R1）
src/            宿主半区（Cordis 插件）
  index.js        插件壳：apply(ctx)
  identifiers.js  纯函数：把输入统一成论文标识符（DOI/arXiv/PMID/标题）
test/           L0 单元测试（node --test）
tools/          开发脚本（e2e、截图等，待加）
icon.svg        插件图标（清单 dsh.icon 引用）
cordis.patch.yml  bundle 层：把自己插入 profile
```

## 设计文档

- [`docs/功能框架-v0.md`](docs/功能框架-v0.md) —— 项目功能框架基线：目标能力、环境基线、
  生态资产、架构事实、路线选择、数据模型、缺口清单、决策问题、里程碑，以及 §12 修订记录（R1）。
  讨论新功能时先看它的 **§12 写作规则**：只对"没有现成成熟方案"的部分做详细可行性分析。

## 开发回路

```powershell
# 1) 装进开发 profile（链接方式，改完无需发布）
dsh plugin --profile dev add link:D:\DSH-Plugins\dsh-doraemon-paper-reader

# 2) 跑 L0 单元测试（不需要 Harness）
npm test

# 3) 起开发 profile 观察加载日志
dsh dev
```

改动宿主半区后需要重启 profile；后续加入浏览器半区后，前端改动刷新页面即可。

## 硬约定

1. **零源码依赖**：不把任何第三方插件写进 dependencies/peerDependencies；不 import 别人的运行时值；不 monkey-patch 官方服务。
2. **命名自占**：slot key、页签 kind、路由前缀、locale 命名空间、配置命名空间、数据目录全部带本包前缀。
3. **保真 > 速度**：镜像构建必须有覆盖率台账，不允许静默丢内容。
4. 付费墙内容只做深度链接与元数据，不抓正文。

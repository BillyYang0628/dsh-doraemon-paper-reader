---
name: doraemon-dev-loop
description: Use when working inside the dsh-doraemon-paper-reader repository — implementing, testing, installing, or debugging this DeepSeek Harness plugin (bundle, host half, client half, reader page). Covers the local dev loop, the test layers, and how to install changes into the dev profile.
---

# 机器猫论文阅读器 · 开发回路（项目级技能）

本仓库是 **DSH 插件**（论文精读工作台）。本技能只讲"怎么干"，**约束与红线以仓库根目录的 `AGENTS.md` 为准**，设计以 `docs/功能框架-v0.md` 为准。

## 定位

- 仓库根：包含 `.git` 的最近祖先（即本仓库目录）。
- 包名 `dsh-doraemon-paper-reader`，`package.json` 里 `dsh.bundle.patch` 指向 `cordis.patch.yml`。
- 宿主半区 `src/`（Cordis 插件）；浏览器半区与阅读器页尚未实现。

## 关键环境变量

profile 启动的 Harness 每个 shell 调用都带 `DSH_PROFILE` 与 `DSH_PROFILE_DIR`（PowerShell 读 `$env:DSH_PROFILE`）。
本机：`DSH_HOME=D:\DSH\home`，开发 profile 为 `dev`，CLI 在 `D:\DSH\npm-global\dsh.cmd`。

## 开发回路

```powershell
# 1) 纯逻辑测试（不需要 Harness 在跑）
npm test

# 2) 加载验证：看启动日志里有没有 [doraemon-paper-reader] host half loaded
dsh dev --no-open

# 3) 把改动装进 dev profile（二选一，都不要手改 profile 的 package.json / cordis.patch.yml）
#    a. 命令行（用户侧正规入口）
dsh plugin --profile dev add link:D:\DSH-Plugins\dsh-doraemon-paper-reader
#    b. Harness 会话内（模型侧正规入口，需 Full access 或逐次批准）
#       用 plugin_manager 工具，action: install_bundle，target 传包目录绝对路径
```

改动生效方式（详见 `docs/开发流程.md` §5）：改 `src/*.js` → 重启 `dsh dev`；改 `package.json` → 重新安装；
改浏览器半区 → 重新构建 + 刷新页面。**任何影响用户日常 `web` / `desktop` profile 的动作都要单独确认。**

## 测试分层

| 层 | 手段 | 何时用 |
|---|---|---|
| L0 | `npm test`（node --test，纯函数） | 每次改动 |
| L1 | `dsh --profile headless "<任务>"` | 工具注册、输出、落盘 |
| L2 | `dsh dev` + 浏览器自动化（Playwright/CDP） | 界面、浮层、页签（待建） |
| L3 | DSH SDK（`--profile sdk`）驱动会话 | 端到端（待建） |

联网用例必须能离线跑：真实响应先落盘成 fixture（`test/fixtures/`），不要依赖"今天网络通"。

## 交付前自检

1. `npm test` 红绿结论 + 未跑项（照实写）；
2. 界面改动附**并排对比截图**（改动前 / 改动后），存 `工具/gen/<主题>-<YYYYMMDD>/`；
3. 回填 `docs/决定台账.md`（新决定）与 `docs/项目索引.md`（新文件/时效）；
4. 复制了第三方代码 → 更新 `THIRD_PARTY_NOTICES.md`；
5. 提交信息用中文，说清"改了什么、为什么"。

## 已踩过的坑（别再踩）

- PowerShell 5.1 写文本会带 **BOM**：写 `package.json` / YAML 一律用 UTF8 无 BOM，写完抽查前三字节。
- `Start-Process` 在本机可能被策略拒：起长驻进程优先用会话方式或 `&`。
- 测试实例用完必须停掉并确认端口释放（日常 web 是 3080，桌面端 Host 是 19387，测试请另选端口）。
- 学术抓取：出版社页面会 403/303，**撞到就停手换渠道**，不硬刚（详见 `AGENTS.md` §2.4）。

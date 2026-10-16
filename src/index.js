// dsh-mirror-reader —— Cordis 插件壳（宿主半区）。
//
// 现阶段目标只有一个：验证这个包能被 profile 正确加载。
// 工具（ctx.tools）、路由（ctx.webServer）、阅读器页与浏览器半区在后续提交里逐个加。
//
// 约定：本包自包含，不依赖任何第三方插件；官方运行时服务通过 ctx 注入获取。

export const name = 'dsh-mirror-reader'

export function apply(ctx) {
  console.log('[dsh-mirror-reader] host half loaded (v0.0.1) — tools/routes pending')
  // 下一步：
  //   ctx.inject(['tools'], (rctx) => rctx.tools.register(resolvePaperTool))
  //   ctx.inject(['webServer', 'connection'], (rctx) => registerRoutes(rctx))
}

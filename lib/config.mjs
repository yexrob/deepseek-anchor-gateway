/**
 * 配置：全部走环境变量，零配置文件。
 *
 *   ANCHOR_UPSTREAM_URL   上游 OpenAI 兼容端点根（不含 /v1 后缀），
 *                          默认 https://api.deepseek.com
 *                          （也兼容配了 /v1 的写法：转发时会剥掉重复段）
 *   ANCHOR_UPSTREAM_KEY   上游 API key；不设则透传客户端的 Authorization
 *   ANCHOR_PORT           监听端口，默认 8787
 *   ANCHOR_KEEP           首轮保留的工具白名单正则，默认见 anchor.mjs
 *   ANCHOR_HOST           监听地址，默认 127.0.0.1
 */
export function loadConfig(env = process.env) {
  return {
    upstreamUrl: (env.ANCHOR_UPSTREAM_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
    upstreamKey: env.ANCHOR_UPSTREAM_KEY || '',
    port: Number(env.ANCHOR_PORT || 8787),
    host: env.ANCHOR_HOST || '127.0.0.1',
    keep: env.ANCHOR_KEEP || undefined, // undefined → anchor.mjs 的默认白名单
  }
}

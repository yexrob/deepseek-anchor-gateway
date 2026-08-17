/**
 * DeepSeek Anchor Gateway — 简易 OpenAI 兼容网关。
 *
 * 在 API 层复刻 dsh anchored-standard：会话首轮只暴露最小工具集
 * （bash/editor 类），让 DeepSeek V4 锚定在 RL 高分区间；首轮之后
 * 恢复客户端原始完整工具目录。
 *
 * 零依赖，Node 18+（需内置 fetch）。用法：
 *   ANCHOR_UPSTREAM_KEY=sk-xxx node server.mjs
 */
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { loadConfig } from './lib/config.mjs'
import { buildAnchoredRequest, buildAnchoredResponsesRequest } from './lib/anchor.mjs'

const MAX_BODY = 32 * 1024 * 1024 // 32MB，防呆上限

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 建网关 http server（不 listen，测试可注入任意端口）。 */
export function createGateway(config) {
  const handler = async (req, res) => {
    const path = (req.url || '/').split('?')[0]
    if ((req.method === 'GET' && path === '/v1/models') ||
        (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/v1/responses'))) {
      await forward(req, res, path, config)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `not found: ${req.method} ${path}` } }))
  }
  return http.createServer(handler)
}

/** 拼上游 URL：base 若已含 /v1 且 path 也以 /v1 开头，剥掉重复段。 */
function joinPath(base, path) {
  const clean = base.replace(/\/+$/, '')
  if (clean.endsWith('/v1') && path.startsWith('/v1')) return clean + path.slice('/v1'.length)
  return clean + path
}

async function forward(req, res, path, config) {
  const raw = await readBody(req)

  let json = null
  try {
    json = JSON.parse(raw.toString('utf8'))
  } catch {
    json = null
  }

  let anchored = false
  let sentBody = json
  let outBody = raw
  if (json) {
    const r = path === '/v1/responses'
      ? buildAnchoredResponsesRequest(json, config.keep)
      : path === '/v1/chat/completions'
        ? buildAnchoredRequest(json, config.keep)
        : { anchored: false, body: json }
    anchored = r.anchored
    sentBody = r.body
    outBody = Buffer.from(JSON.stringify(r.body), 'utf8')
  }

  const headers = { 'content-type': req.headers['content-type'] || 'application/json' }
  if (config.upstreamKey) headers.authorization = `Bearer ${config.upstreamKey}`
  else if (req.headers.authorization) headers.authorization = req.headers.authorization
  if (req.headers['accept']) headers.accept = req.headers['accept']

  let upstream
  try {
    upstream = await fetch(joinPath(config.upstreamUrl, path), {
      method: req.method,
      headers,
      body: req.method === 'POST' || req.method === 'PUT' ? outBody : undefined,
    })
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `upstream unreachable: ${err.message}` } }))
    console.error(`[anchor-gw] upstream error ${path}: ${err.message}`)
    return
  }

  // 透传状态与响应头；streaming（SSE）整流直通。
  const passHeaders = {}
  for (const [k, v] of upstream.headers) {
    if (k.toLowerCase() === 'content-encoding' || k.toLowerCase() === 'transfer-encoding') continue
    passHeaders[k] = v
  }
  res.writeHead(upstream.status, passHeaders)

  if (upstream.body) {
    if (upstream.headers.get('content-type')?.includes('text/event-stream')) {
      Readable.fromWeb(upstream.body).pipe(res)
    } else {
      const buf = Buffer.from(await upstream.arrayBuffer())
      res.end(buf)
    }
  } else {
    res.end()
  }

  const model = json && json.model ? json.model : '?'
  const toolsN = json && Array.isArray(json.tools) ? json.tools.length : '-'
  const keptN = sentBody && Array.isArray(sentBody.tools) ? sentBody.tools.length : toolsN
  console.log(`[anchor-gw] ${req.method} ${path} ${upstream.status} model=${model} tools=${toolsN}${anchored ? ` ANCHORED→${keptN}` : ''}`)

  if (process.env.ANCHOR_DEBUG) {
    const keptNames = sentBody && Array.isArray(sentBody.tools) ? sentBody.tools.map((t) => (t.name || (t.function && t.function.name))).filter(Boolean) : []
    const instOrig = json && json.instructions ? json.instructions : ''
    const instSent = sentBody && sentBody.instructions ? sentBody.instructions : ''
    const input = json && Array.isArray(json.input) ? json.input : null
    const inputN = input ? input.length : (json && Array.isArray(json.messages) ? json.messages.length : '-')
    const inputKinds = input ? input.map((i) => `${i.type}:${i.role || (i.name || '')}`).join(',') : ''
    console.log(`[anchor-gw]   kept=[${keptNames.join(',')}] origInst=${instOrig.length}chars sentInst=${instSent.length}chars input=${inputN} [${inputKinds}]`)
    console.log(`[anchor-gw]   sentInstHead=${instSent.slice(0, 60).replace(/\n/g, ' ')}`)
  }
}

export function start(config) {
  const server = createGateway(config)
  return new Promise((resolve) => {
    server.listen(config.port, config.host, () => resolve(server))
  })
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const cfg = loadConfig()
  start(cfg).then(() => {
    console.log(`[anchor-gw] listening on http://${cfg.host}:${cfg.port}`)
    console.log(`[anchor-gw] upstream: ${cfg.upstreamUrl}${cfg.upstreamKey ? ' (key set)' : ' (client key passthrough)'}`)
    console.log(`[anchor-gw] first-request keep: ${cfg.keep || 'default bash/editor set'}`)
  })
}

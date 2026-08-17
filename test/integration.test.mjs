/**
 * 端到端：mock 上游 + 真网关，验证首轮裁剪、次轮恢复、streaming 透传。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createGateway } from '../server.mjs'

const seen = [] // 上游收到的请求体 { path, json, auth }
let mock
let gw
let base

const TOOLS = [
  { name: 'bash', description: 'run' },
  { name: 'Read', description: 'read' },
  { name: 'Edit', description: 'edit' },
  { name: 'Glob', description: 'glob' },
  { name: 'Grep', description: 'grep' },
]

before(async () => {
  mock = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      seen.push({ path: req.url, json: raw ? JSON.parse(raw) : null, auth: req.headers.authorization || '' })
      if (req.url.startsWith('/v1/chat/completions') && JSON.parse(raw).stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: {"id":"1","choices":[{"delta":{"content":"a"}}]}\n\n')
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'mock-1', choices: [{ message: { role: 'assistant', content: 'ok' } }] }))
    })
  })
  await new Promise((r) => mock.listen(0, '127.0.0.1', r))
  const port = mock.address().port

  gw = createGateway({ upstreamUrl: `http://127.0.0.1:${port}`, upstreamKey: 'upstream-secret', keep: undefined })
  await new Promise((r) => gw.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${gw.address().port}/v1`
})

after(() => {
  gw.close()
  mock.close()
})

function post(path, body, headers = {}) {
  return fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

test('首轮请求：工具被裁剪，system prompt 保留，上游 key 生效', async () => {
  const res = await post('/chat/completions', {
    model: 'deepseek-v4-pro',
    messages: [{ role: 'system', content: 'CLIENT-SYSTEM-PROMPT' }, { role: 'user', content: 'hi' }],
    tools: TOOLS,
  })
  assert.equal(res.status, 200)
  const up = seen.at(-1)
  assert.deepEqual(up.json.tools.map((t) => t.name), ['bash', 'Edit'])
  assert.equal(up.json.messages[0].content, 'CLIENT-SYSTEM-PROMPT') // system prompt 原样
  assert.equal(up.auth, 'Bearer upstream-secret') // 网关 key 覆盖客户端
})

test('次轮请求（含 assistant 消息）：完整工具原样透传', async () => {
  const res = await post('/chat/completions', {
    model: 'deepseek-v4-pro',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok', tool_calls: [{ id: 'c1', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '{}' },
    ],
    tools: TOOLS,
  })
  assert.equal(res.status, 200)
  const up = seen.at(-1)
  assert.deepEqual(up.json.tools.map((t) => t.name), ['bash', 'Read', 'Edit', 'Glob', 'Grep'])
})

test('streaming：SSE 原样透传', async () => {
  const res = await post('/chat/completions', {
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: 'hi' }],
    tools: TOOLS,
    stream: true,
  })
  assert.equal(res.status, 200)
  const text = await res.text()
  assert.match(text, /data: \[DONE\]/)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)
  // streaming 请求同样被锚定
  assert.deepEqual(seen.at(-1).json.tools.map((t) => t.name), ['bash', 'Edit'])
})

test('客户端 key 透传：未配网关 key 时用客户端 Authorization', async () => {
  const gw2 = createGateway({ upstreamUrl: `http://127.0.0.1:${mock.address().port}`, upstreamKey: '', keep: undefined })
  await new Promise((r) => gw2.listen(0, '127.0.0.1', r))
  const res = await fetch(`http://127.0.0.1:${gw2.address().port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer client-secret' },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools: TOOLS }),
  })
  assert.equal(res.status, 200)
  assert.equal(seen.at(-1).auth, 'Bearer client-secret')
  gw2.close()
})

test('/v1/models 透传', async () => {
  const res = await fetch(base + '/models')
  assert.equal(res.status, 200)
  assert.ok(seen.at(-1).path.startsWith('/v1/models'))
})

test('upstreamUrl 带 /v1 后缀也能正确转发（不产生 /v1/v1）', async () => {
  const gw3 = createGateway({ upstreamUrl: `http://127.0.0.1:${mock.address().port}/v1`, upstreamKey: 'k', keep: undefined })
  await new Promise((r) => gw3.listen(0, '127.0.0.1', r))
  const res = await fetch(`http://127.0.0.1:${gw3.address().port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools: TOOLS }),
  })
  assert.equal(res.status, 200)
  assert.equal(seen.at(-1).path, '/v1/chat/completions')
  gw3.close()
})

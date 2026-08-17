import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isPromoted, filterTools, buildAnchoredRequest,
  isResponsesPromoted, unlockedResponsesNames, buildAnchoredResponsesRequest,
  isUserTurnStart, isReminderMessage, stripReminders, DEFAULT_HINT,
} from '../lib/anchor.mjs'

const TOOLS = [
  { name: 'bash', description: 'run commands' },
  { name: 'Read', description: 'read file' },
  { name: 'Edit', description: 'edit file' },
  { name: 'str_replace_editor', description: 'minimal editor' },
  { name: 'Write', description: 'write file' },
  { name: 'Glob', description: 'glob' },
  { name: 'Grep', description: 'grep' },
  { name: 'WebFetch', description: 'fetch url' },
  { name: 'TodoWrite', description: 'todo' },
]

test('isPromoted: 只有 system+user 未提升', () => {
  assert.equal(isPromoted([{ role: 'system' }, { role: 'user' }]), false)
})

test('isPromoted: 出现 assistant 即提升（含 tool_calls 回复）', () => {
  assert.equal(isPromoted([{ role: 'system' }, { role: 'user' }, { role: 'assistant', content: 'hi' }]), true)
  assert.equal(
    isPromoted([{ role: 'system' }, { role: 'user' }, { role: 'assistant', tool_calls: [{ id: 'x' }] }, { role: 'tool' }]),
    true,
  )
})

test('filterTools: 默认白名单保留 bash/editor/write 类', () => {
  const kept = filterTools(TOOLS)
  const names = kept.map((t) => t.name)
  assert.deepEqual(names, ['bash', 'Edit', 'str_replace_editor', 'Write'])
})

test('filterTools: 非数组原样返回', () => {
  assert.equal(filterTools(undefined), undefined)
})

test('buildAnchoredRequest: 首轮裁剪工具', () => {
  const body = { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS }
  const { anchored, body: out } = buildAnchoredRequest(body)
  assert.equal(anchored, true)
  assert.deepEqual(out.tools.map((t) => t.name), ['bash', 'Edit', 'str_replace_editor', 'Write'])
})

test('buildAnchoredRequest: 首轮 tool_choice 指向被裁工具时降级为 auto', () => {
  const body = {
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: 'hi' }],
    tools: TOOLS,
    tool_choice: { type: 'function', function: { name: 'WebFetch' } },
  }
  const { anchored, body: out } = buildAnchoredRequest(body)
  assert.equal(anchored, true)
  assert.equal(out.tool_choice, 'auto')
})

test('buildAnchoredRequest: tool_choice 指向保留工具时不动', () => {
  const body = {
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: 'hi' }],
    tools: TOOLS,
    tool_choice: { type: 'function', function: { name: 'bash' } },
  }
  const { body: out } = buildAnchoredRequest(body)
  assert.deepEqual(out.tool_choice, { type: 'function', function: { name: 'bash' } })
})

test('buildAnchoredRequest: 已提升（有 assistant）原样透传', () => {
  const body = { model: 'm', messages: [{ role: 'user' }, { role: 'assistant', content: 'x' }], tools: TOOLS }
  const { anchored, body: out } = buildAnchoredRequest(body)
  assert.equal(anchored, false)
  assert.equal(out, body) // 同一对象引用，未克隆
})

test('buildAnchoredRequest: 无 tools 字段不动', () => {
  const body = { model: 'm', messages: [{ role: 'user', content: 'hi' }] }
  const { anchored, body: out } = buildAnchoredRequest(body)
  assert.equal(anchored, false)
  assert.equal(out, body)
})

test('buildAnchoredRequest: tools 已是白名单子集不动', () => {
  const body = { model: 'm', messages: [{ role: 'user' }], tools: [{ name: 'bash' }] }
  const { anchored } = buildAnchoredRequest(body)
  assert.equal(anchored, false)
})

test('filterTools: 兼容嵌套结构（tools[].function.name）', () => {
  const nested = [
    { type: 'function', function: { name: 'bash' } },
    { type: 'function', function: { name: 'Read' } },
    { type: 'function', function: { name: 'WebFetch' } },
  ]
  const kept = filterTools(nested)
  assert.deepEqual(kept.map((t) => t.function.name), ['bash'])
})

test('filterTools: 无 name 的工具被裁掉而非报错', () => {
  const kept = filterTools([{ type: 'function' }, { name: 'bash' }])
  assert.deepEqual(kept.map((t) => t.name).filter(Boolean), ['bash'])
})

test('buildAnchoredRequest: 嵌套结构首轮正确裁剪', () => {
  const body = {
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      { type: 'function', function: { name: 'bash' } },
      { type: 'function', function: { name: 'Read' } },
      { type: 'function', function: { name: 'Glob' } },
    ],
  }
  const { anchored, body: out } = buildAnchoredRequest(body)
  assert.equal(anchored, true)
  assert.deepEqual(out.tools.map((t) => t.function.name), ['bash'])
})

test('buildAnchoredRequest: 自定义白名单正则生效', () => {
  const body = { model: 'm', messages: [{ role: 'user' }], tools: TOOLS }
  const { body: out } = buildAnchoredRequest(body, '^(read|grep)$')
  assert.deepEqual(out.tools.map((t) => t.name), ['Read', 'Grep'])
})

// ── Responses API ──────────────────────────────────────────────────────────

const RTOOLS = [
  { type: 'function', name: 'bash', description: 'run', parameters: {} },
  { type: 'function', name: 'Read', description: 'read', parameters: {} },
  { type: 'function', name: 'WebFetch', description: 'fetch', parameters: {} },
]

test('isResponsesPromoted: 无 assistant 历史未提升', () => {
  assert.equal(isResponsesPromoted([{ type: 'message', role: 'user', content: 'hi' }]), false)
})

test('isResponsesPromoted: assistant 消息或 function_call 即提升', () => {
  assert.equal(isResponsesPromoted([{ type: 'message', role: 'user' }, { type: 'message', role: 'assistant', content: [] }]), true)
  assert.equal(isResponsesPromoted([{ type: 'message', role: 'user' }, { type: 'function_call', call_id: 'c1', name: 'bash', arguments: '{}' }]), true)
})

test('unlockedResponsesNames: 提取历史中调用过的工具名', () => {
  const names = unlockedResponsesNames([
    { type: 'message', role: 'user', content: 'hi' },
    { type: 'function_call', call_id: 'c1', name: 'bash', arguments: '{}' },
    { type: 'function_call', call_id: 'c2', name: 'WebFetch', arguments: '{}' },
  ])
  assert.deepEqual([...names], ['bash', 'WebFetch'])
})

test('isUserTurnStart: 最后一个是 user 消息即开局轮', () => {
  assert.equal(isUserTurnStart([{ type: 'message', role: 'user', content: 'hi' }]), true)
  // 同一 session 里用户发新消息后的第一轮：历史 + 尾部 user
  assert.equal(isUserTurnStart([
    { type: 'message', role: 'user' },
    { type: 'function_call', call_id: 'c1', name: 'bash', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: '{}' },
    { type: 'message', role: 'user', content: '新消息' },
  ]), true)
})

test('isUserTurnStart: 工具 continuation 轮不是开局轮', () => {
  // 最后一个条目是 function_call_output（工具结果）→ continuation
  assert.equal(isUserTurnStart([
    { type: 'message', role: 'user' },
    { type: 'function_call', call_id: 'c1', name: 'bash', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: '{}' },
  ]), false)
})

test('isUserTurnStart: 空 input / 非数组不是开局轮', () => {
  assert.equal(isUserTurnStart([]), false)
  assert.equal(isUserTurnStart(undefined), false)
})

test('buildAnchoredResponsesRequest: 首轮裁剪 tools 并替换 instructions', () => {
  const body = {
    model: 'deepseek-v4-pro',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    tools: RTOOLS,
    instructions: 'LONG INSTRUCTIONS '.repeat(100),
  }
  const { anchored, body: out } = buildAnchoredResponsesRequest(body)
  assert.equal(anchored, true)
  assert.deepEqual(out.tools.map((t) => t.name), ['bash'])
  assert.equal(out.instructions, 'You are a helpful software engineer assistant.')
})

test('buildAnchoredResponsesRequest: 用户新消息后的开局轮 persona（无 hint）', () => {
  // 同一 session 历史 + 尾部新用户消息 → persona；工具照常锚定
  const instr = 'FULL SYSTEM PROMPT '.repeat(200)
  const body = {
    model: 'deepseek-v4-pro',
    input: [
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'function_call', call_id: 'c1', name: 'bash', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: '{}' },
      { type: 'message', role: 'user', content: '新消息' },
    ],
    tools: RTOOLS,
    instructions: instr,
  }
  const { anchored, body: out } = buildAnchoredResponsesRequest(body)
  assert.equal(anchored, true)
  assert.equal(out.instructions, 'You are a helpful software engineer assistant.') // 开局轮无 hint
  assert.deepEqual(out.tools.map((t) => t.name), ['bash']) // bash 白名单；WebFetch 未被调用被裁
})

test('buildAnchoredResponsesRequest: 工具 continuation 轮 persona + hint（不恢复完整 system）', () => {
  // 对齐 opencode-anchored：system 全程保持 persona，不恢复完整版
  const instr = 'FULL SYSTEM PROMPT '.repeat(200)
  const body = {
    model: 'deepseek-v4-pro',
    input: [
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'function_call', call_id: 'c1', name: 'bash', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: '{}' },
    ],
    tools: RTOOLS,
    instructions: instr,
  }
  const { body: out } = buildAnchoredResponsesRequest(body)
  assert.equal(out.instructions, 'You are a helpful software engineer assistant.' + DEFAULT_HINT)
  assert.deepEqual(out.tools.map((t) => t.name), ['bash']) // 工具仍锚定
})

test('isReminderMessage: 识别 bingo 自动注入的 SYSTEM NOTIFICATION', () => {
  assert.equal(isReminderMessage({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '[SYSTEM NOTIFICATION - TASK REMINDER] hello' }] }), true)
  assert.equal(isReminderMessage({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '真实消息' }] }), false)
  assert.equal(isReminderMessage({ type: 'function_call', call_id: 'c1' }), false)
})

test('stripReminders: 剔除自动注入，保留真实消息', () => {
  const input = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '真实任务' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[SYSTEM NOTIFICATION - TASK REMINDER] blah' }] },
  ]
  const out = stripReminders(input)
  assert.equal(out.length, 1)
  assert.equal(out[0].content[0].text, '真实任务')
})

test('buildAnchoredResponsesRequest: 开局轮剥离自动注入提醒', () => {
  const body = {
    model: 'deepseek-v4-pro',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '写一个黑洞模拟' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '[SYSTEM NOTIFICATION - TASK REMINDER] the task tools...' }] },
    ],
    tools: RTOOLS,
    instructions: 'FULL SYSTEM PROMPT '.repeat(100),
  }
  const { anchored, body: out } = buildAnchoredResponsesRequest(body)
  assert.equal(anchored, true)
  assert.equal(out.input.length, 1)
  assert.equal(out.instructions, 'You are a helpful software engineer assistant.')
})

test('buildAnchoredResponsesRequest: 无 instructions 字段不报错', () => {
  const body = {
    model: 'm',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    tools: RTOOLS,
  }
  const { anchored, body: out } = buildAnchoredResponsesRequest(body)
  assert.equal(anchored, true)
  assert.equal(out.instructions, undefined)
})

test('buildAnchoredResponsesRequest: 已提升会话仍裁剪（持续锚定，防 post-promotion 回归）', () => {
  // 有 assistant 历史 + 103 工具全量 → 仍裁剪到白名单；instructions 保持 persona+hint
  const tools = [
    ...RTOOLS,
    ...Array.from({ length: 100 }, (_, i) => ({ type: 'function', name: `MCP_${i}`, parameters: {} })),
  ]
  const instr = 'FULL SYSTEM PROMPT '.repeat(100)
  const body = {
    model: 'deepseek-v4-pro',
    input: [
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
      { type: 'function_call_output', call_id: 'c1', output: '{}' },
    ],
    tools,
    instructions: instr,
  }
  const { anchored, body: out } = buildAnchoredResponsesRequest(body)
  assert.equal(anchored, true)
  assert.equal(out.tools.length, 1) // 只有 bash（Read/WebFetch 也裁掉）
  assert.deepEqual(out.tools.map((t) => t.name), ['bash'])
  assert.equal(out.instructions, 'You are a helpful software engineer assistant.' + DEFAULT_HINT) // 全程 persona+hint
})

test('buildAnchoredResponsesRequest: 调用过的工具自动解锁保留', () => {
  const body = {
    model: 'deepseek-v4-pro',
    input: [
      { type: 'message', role: 'user', content: 'fetch' },
      { type: 'function_call', call_id: 'c1', name: 'WebFetch', arguments: '{}' },
    ],
    tools: RTOOLS,
  }
  const { anchored, body: out } = buildAnchoredResponsesRequest(body)
  assert.equal(anchored, true)
  // WebFetch 被调用过 → 保留；Read 未调用过 → 裁掉
  assert.deepEqual(out.tools.map((t) => t.name), ['bash', 'WebFetch'])
})

test('buildAnchoredResponsesRequest: 全部工具已解锁/白名单时不动', () => {
  const body = {
    model: 'm',
    input: [{ type: 'message', role: 'user' }, { type: 'function_call', call_id: 'c1', name: 'bash', arguments: '{}' }],
    tools: RTOOLS.slice(0, 1), // 只有 bash
  }
  const { anchored } = buildAnchoredResponsesRequest(body)
  assert.equal(anchored, false)
})

test('buildAnchoredResponsesRequest: tool_choice 钉住被裁工具降级 auto', () => {
  const body = {
    model: 'm',
    input: [{ type: 'message', role: 'user' }],
    tools: RTOOLS,
    tool_choice: { type: 'function', name: 'WebFetch' },
  }
  const { body: out } = buildAnchoredResponsesRequest(body)
  assert.equal(out.tool_choice, 'auto')
})

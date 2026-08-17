/**
 * 锚定（anchoring）核心逻辑，纯函数、无副作用，便于单元测试。
 *
 * 原理（复现自 deepseek-harness 社区 anchored-standard 工作，
 * 见 xiaobright/dsh-anchored-standard，issue #6 / #11）：
 *
 *   DeepSeek V4 对「API 可见的首轮工具目录」高度敏感：
 *   - Minimal 条件（bash + str_replace_editor 两个工具）→ RL 高分区间（We need... 模式）
 *   - 标准目录（20+ 工具 + 大段 prompt）→ 降级为 Let me... 工具轮换模式
 *
 * 网关在 API 层复刻：
 *   会话的第一个请求（messages 中尚无任何 assistant 消息）只暴露最小工具集；
 *   一旦出现首条 assistant 消息（含 tool_calls 的回复也算），会话即「提升」，
 *   后续请求原样透传完整工具目录。等价于 dsh 的 promoteOn: 'either'。
 */

/** 首轮保留的最小工具白名单（正则，大小写不敏感）。 */
export const DEFAULT_KEEP = '^(bash|shell|zsh|pwsh|str_replace_editor|.*edit.*|write)$'

/** minimal persona（dsh minimal preset 原话）。 */
export const DEFAULT_PERSONA = 'You are a helpful software engineer assistant.'

/**
 * 非开局轮的 instruction hint（dsh instruction-hint 做法）：
 * 不注入完整系统提示词（那会拉回 standard 轨迹），只提示指令文件存在，
 * 让模型按需自己读取 CLAUDE.md 等文件。
 */
export const DEFAULT_HINT = '\n\nSystem instructions and project rules exist in workspace files (e.g. CLAUDE.md). Read relevant files before acting when needed.'

/** bingo 每轮自动注入的 system-reminder 前缀（dsh context-gate 会剥离这类自动注入）。 */
export const REMINDER_PREFIX = '[SYSTEM NOTIFICATION'

/** 会话是否已提升：messages 中出现过 assistant 消息（含 tool_calls 回复）。 */
export function isPromoted(messages) {
  if (!Array.isArray(messages)) return false
  return messages.some((m) => m && m.role === 'assistant')
}

/** 取工具名：兼容扁平（{name}）与嵌套（{function:{name}}）两种 OpenAI 方言。 */
export function toolName(t) {
  if (!t || typeof t !== 'object') return undefined
  if (typeof t.name === 'string' && t.name) return t.name
  if (t.function && typeof t.function.name === 'string' && t.function.name) return t.function.name
  return undefined
}

/** 按白名单正则过滤工具列表（保持原结构，只过滤不转换）。 */
export function filterTools(tools, keep = DEFAULT_KEEP) {
  if (!Array.isArray(tools)) return tools
  const re = new RegExp(keep, 'i')
  return tools.filter((t) => {
    const name = toolName(t)
    return typeof name === 'string' && re.test(name)
  })
}

/**
 * Responses API 工具名：`{type:"function", name, description, parameters}`，
 * name 在顶层（与 chat 的嵌套 `{function:{name}}` 不同）。
 */
export function responsesToolName(t) {
  if (!t || typeof t !== 'object') return undefined
  if (typeof t.name === 'string' && t.name) return t.name
  return undefined
}

/**
 * Responses API 是否已提升：input 中出现 assistant 消息或 function_call。
 * （保留供诊断/测试；持续锚定模式下每轮都会裁剪，不依赖此判定。）
 */
export function isResponsesPromoted(input) {
  if (!Array.isArray(input)) return false
  return input.some((item) => {
    if (!item || typeof item !== 'object') return false
    if (item.type === 'function_call') return true
    if (item.type === 'message' && item.role === 'assistant') return true
    return false
  })
}

/**
 * 该会话历史上模型已调用过的工具名（responses input 中的 function_call）。
 * 这是「按需解锁」信号：模型调用过的工具即使不在白名单，也保留进下一轮目录。
 */
export function unlockedResponsesNames(input) {
  const names = new Set()
  if (!Array.isArray(input)) return names
  for (const item of input) {
    if (item && item.type === 'function_call' && typeof item.name === 'string' && item.name) {
      names.add(item.name)
    }
  }
  return names
}

/**
 * 该轮是否「用户消息后的开局轮」：input 最后一个条目是用户消息。
 *
 * 会话第一轮、以及同一 session 里用户每发一条新消息后的第一个请求，
 * 都满足此条件——模型在这些轮次「重新进入工作状态」，注入条件决定它
 * 走 minimal 还是 standard 轨迹。实测：完整 instructions 下这些轮次
 * 回退为 Let me（工具 continuation 轮次不受影响）。
 *
 * responses 协议里工具结果用 function_call_output，不占 message:user，
 * 所以「最后一个条目是 message:user」= 用户真实消息（或系统通知）。
 */
export function isUserTurnStart(input) {
  if (!Array.isArray(input) || input.length === 0) return false
  const last = input[input.length - 1]
  return !!last && typeof last === 'object' && last.type === 'message' && last.role === 'user'
}

/**
 * 是否自动注入提醒消息（bingo 的 [SYSTEM NOTIFICATION - TASK REMINDER]）。
 * 这类注入会污染首轮轨迹（dsh context-gate 的默认行为是剥离），开局轮应剔除。
 */
export function isReminderMessage(item) {
  if (!item || typeof item !== 'object') return false
  if (item.type !== 'message' || item.role !== 'user') return false
  const content = item.content
  if (!Array.isArray(content) || content.length === 0) return false
  const first = content[0]
  if (!first || typeof first !== 'object') return false
  const text = first.text || ''
  return typeof text === 'string' && text.trimStart().startsWith(REMINDER_PREFIX)
}

/** 开局轮剔除自动注入提醒，保留真实用户消息。 */
export function stripReminders(input) {
  if (!Array.isArray(input)) return input
  const filtered = input.filter((item) => !isReminderMessage(item))
  return filtered.length === input.length ? input : filtered
}

/**
 * 对 /v1/responses 请求体做锚定改写。
 *
 * 两种模式：
 * - 持续锚定（默认，promoteAfterFirst=false）：每轮工具都裁剪，
 *   目录 = 白名单 ∪ 历史已调用工具；instructions 全程 persona。
 * - 首轮提升（promoteAfterFirst=true）：开局轮（会话首轮 / 用户新消息后
 *   第一轮）裁剪工具 + persona；之后轮次全量工具原样透传，instructions
 *   仍保持 persona + hint（对齐 opencode-anchored：system 全程 minimal）。
 *
 * - 开局轮额外剥离自动注入提醒（bingo 的 SYSTEM NOTIFICATION）。
 *
 * 返回 { anchored, body, keptNames }。
 */
export function buildAnchoredResponsesRequest(body, keep = DEFAULT_KEEP, persona = DEFAULT_PERSONA, hint = DEFAULT_HINT, promoteAfterFirst = false) {
  if (!body || typeof body !== 'object') return { anchored: false, body, keptNames: [] }
  if (!Array.isArray(body.input)) return { anchored: false, body, keptNames: [] }

  const userTurnStart = isUserTurnStart(body.input)
  const tools = body.tools
  let next = body
  let anchored = false

  // 工具：开局轮总是裁剪；非开局轮按模式决定
  if (Array.isArray(tools) && (userTurnStart || !promoteAfterFirst)) {
    const unlocked = unlockedResponsesNames(body.input)
    const re = new RegExp(keep, 'i')
    const kept = tools.filter((t) => {
      const name = responsesToolName(t)
      if (!name) return false
      return re.test(name) || unlocked.has(name)
    })
    if (kept.length !== tools.length) {
      next = { ...next, tools: kept }
      anchored = true
      // tool_choice 钉住被裁工具时降级 "auto"
      const tc = body.tool_choice
      if (tc && typeof tc === 'object' && tc.name) {
        if (!kept.some((t) => responsesToolName(t) === tc.name)) next.tool_choice = 'auto'
      }
    }
  }

  // instructions 全程 persona（不恢复完整版）
  if (typeof body.instructions === 'string' && body.instructions.length > persona.length) {
    next = next === body ? { ...body } : next
    next.instructions = userTurnStart ? persona : persona + hint
    anchored = true
  }

  // 开局轮剥离自动注入提醒（真实用户消息之后追加的 system-reminder）
  if (userTurnStart && isReminderMessage(body.input[body.input.length - 1])) {
    next = next === body ? { ...body } : next
    next.input = stripReminders(body.input)
    anchored = true
  }

  const keptNames = next !== body && Array.isArray(next.tools) ? next.tools.map(responsesToolName) : []
  return { anchored, body: next, keptNames }
}

/**
 * 对 /v1/chat/completions 请求体做锚定改写。
 * 返回 { anchored, body }：anchored=true 表示本轮被裁剪；body 为实际转发体。
 */
export function buildAnchoredRequest(body, keep = DEFAULT_KEEP) {
  if (!body || typeof body !== 'object') return { anchored: false, body }
  if (!Array.isArray(body.messages)) return { anchored: false, body }
  if (isPromoted(body.messages)) return { anchored: false, body }

  const tools = body.tools
  if (!Array.isArray(tools)) return { anchored: false, body }
  const kept = filterTools(tools, keep)
  if (kept.length === tools.length) return { anchored: false, body }

  const next = { ...body, tools: kept }

  // 客户端若用 tool_choice 钉死某个被裁掉的工具，会直接 400；降级为 auto。
  const tc = body.tool_choice
  if (tc && typeof tc === 'object' && tc.function && tc.function.name) {
    if (!kept.some((t) => toolName(t) === tc.function.name)) next.tool_choice = 'auto'
  }

  return { anchored: true, body: next }
}

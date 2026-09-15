// classify.mjs — Codex rollout 行 → 规范化 IR 条目。
//
// 这是归档里的 `normalized.jsonl`：派生的、可再生的便利层。权威副本始终是
// `source.jsonl.zst`（逐字节原文），所以这里**不需要无损**——但它必须诚实：
// 认不出的记录归入 `unknown` 并带上原始载荷，绝不静默丢弃。
//
// 全部字段名均在真实语料上核验过（5538 个 rollout，随机抽样）。核验中发现的
// 两处**版本差异**，本模块都处理：
//
//   1. `event_msg/agent_message` 有两种形态并存——早期版本用 `message`（字符串），
//      较新版本用 `content`（块数组）外加 `author` / `recipient`。实测同一样本内
//      两者分别为 2448 与 1409 条。
//   2. `web_search_call` 用 `id` 而非 `call_id`，与它配对的 `web_search_end` 用
//      `call_id`。只读一个字段会静默产生无法配对的输出。
//
// 还有一个必须记住的事实：`reasoning.content` **实测恒为 null**，可读文本只在
// `summary`，且 `summary` 是块数组不是字符串。encrypted_content 是不透明密文。

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

/**
 * 规范列举的 8 类，另加三个在真实语料里存在且下游需要的类别：
 *   session-meta  每个 rollout 的第一行，`meta.json` 的来源
 *   context       会话在哪里、用什么模型、按什么策略批准（含 `world_state` 快照）
 *   goal          用户自己写下的目标（`thread_goal_updated`）
 * 认不出的记录仍然进 `unknown` 并带原始载荷——这份清单是"已知"的边界，不是白名单。
 */
export const ENTRY_KINDS = /** @type {const} */ ([
  'session-meta', 'context', 'goal', 'message', 'tool-call', 'tool-output',
  'reasoning', 'boundary', 'telemetry', 'compaction', 'unknown',
])

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 从任意形态的 content 里取可读文本。
 *
 * 实测需要处理三种：字符串（早期 agent_message）、块数组（message 与多数事件）、
 * null（reasoning.content 恒为 null）。图片按沿用仓库既有做法的标记带出，不静默丢。
 * @param {unknown} content - 原始 content 字段。
 * @returns {string}
 */
export function textOf(content) {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') { parts.push(block); continue }
    if (!isObject(block)) continue
    const type = block.type
    if (typeof block.text === 'string' && (type === 'input_text' || type === 'output_text' || type === 'text' || type === 'summary_text')) {
      parts.push(block.text)
    } else if (type === 'input_image' || type === 'output_image') {
      parts.push('[image]')
    }
  }
  return parts.join('\n')
}

/** 数值叶子收集，供遥测条目使用。 */
function numericLeaves(value, prefix = '', out = {}) {
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) numericLeaves(child, prefix ? `${prefix}.${key}` : key, out)
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    out[prefix] = value
  }
  return out
}

/** 去掉 undefined 字段——归档里的 null 必须是数据，不是缺省值的痕迹。 */
function defined(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))
}

/**
 * 把一行已解析的记录归入 IR。
 *
 * 每条条目都带 `channel`（顶层 `type`）与 `payloadType`（`payload.type`，没有就不带），
 * 因为**记录名本身是事实**：`agent_message` 与 `token_count` 都来自 `event_msg`，只看
 * `kind` 的读者没法知道这一行原本是什么，只能从字段形状反推——那正是版本一变就失效的
 * 那种推断。`unknown` 早就有这两个字段，已知类型没有，是个不一致。
 * @param {unknown} record - 一行 JSON。
 * @param {number} line - 1 起的行号。
 * @returns {Record<string, unknown>} 规范化条目（含 `kind` 与 `line`）。
 */
export function classifyRecord(record, line) {
  if (!isObject(record)) return { line, kind: 'unknown', reason: 'not-an-object' }
  const channel = typeof record.type === 'string' ? record.type : 'unknown'
  const payload = isObject(record.payload) ? record.payload : null
  const payloadType = payload && typeof payload.type === 'string' ? payload.type : null
  /** 每条条目都带的记录名。 */
  const name = defined({ channel, payloadType: payloadType ?? undefined })

  if (channel === 'session_meta') {
    return {
      line,
      kind: 'session-meta',
      ...name,
      id: typeof payload?.id === 'string' ? payload.id : undefined,
      cwd: typeof payload?.cwd === 'string' ? payload.cwd : undefined,
      timestamp: typeof payload?.timestamp === 'string' ? payload.timestamp : undefined,
      cliVersion: typeof payload?.cli_version === 'string' ? payload.cli_version : undefined,
      originator: typeof payload?.originator === 'string' ? payload.originator : undefined,
      modelProvider: typeof payload?.model_provider === 'string' ? payload.model_provider : undefined,
    }
  }

  if (channel === 'turn_context') {
    return defined({
      line,
      kind: 'context',
      ...name,
      cwd: typeof payload?.cwd === 'string' ? payload.cwd : undefined,
      model: typeof payload?.model === 'string' ? payload.model : undefined,
      approvalPolicy: typeof payload?.approval_policy === 'string' ? payload.approval_policy : undefined,
    })
  }

  // 这一条是把真实语料跑过一遍之后才补上的：`thread_settings_applied` 在 50 个真实会话里
  // 出现 323 次，是出现最多的未建模类型。它带的 `thread_settings` 覆盖 cwd、model、
  // approval_policy、reasoning_effort——会话在哪、用什么模型、按什么策略批准，全都在里面。
  // 把它当 unknown 丢进 raw，等于让下游为了拿这三个字段去解析一整棵没有契约的树。
  if (channel === 'event_msg' && payloadType === 'thread_settings_applied') {
    const settings = isObject(payload?.thread_settings) ? payload.thread_settings : {}
    return defined({
      line,
      kind: 'context',
      ...name,
      threadId: typeof payload?.thread_id === 'string' ? payload.thread_id : undefined,
      cwd: typeof settings.cwd === 'string' ? settings.cwd : undefined,
      model: typeof settings.model === 'string' ? settings.model : undefined,
      approvalPolicy: typeof settings.approval_policy === 'string' ? settings.approval_policy : undefined,
      reasoningEffort: typeof settings.reasoning_effort === 'string' ? settings.reasoning_effort : undefined,
    })
  }

  // 用户自己写下的目标。这是「用户说过要做什么」的唯一结构化来源，别让它掉进 raw。
  if (channel === 'event_msg' && payloadType === 'thread_goal_updated') {
    const goal = isObject(payload?.goal) ? payload.goal : {}
    return defined({
      line,
      kind: 'goal',
      ...name,
      threadId: typeof goal.threadId === 'string' ? goal.threadId : undefined,
      objective: typeof goal.objective === 'string' ? goal.objective : undefined,
      status: typeof goal.status === 'string' ? goal.status : undefined,
      tokensUsed: typeof goal.tokensUsed === 'number' ? goal.tokensUsed : undefined,
      createdAt: typeof goal.createdAt === 'number' ? goal.createdAt : undefined,
      updatedAt: typeof goal.updatedAt === 'number' ? goal.updatedAt : undefined,
    })
  }

  // 多 agent 运行的簿记：只有一个布尔量，但仍然是一条真实记录，不该被算作"认不出"。
  if (channel === 'inter_agent_communication_metadata') {
    return defined({
      line,
      kind: 'telemetry',
      ...name,
      source: channel,
      metrics: numericLeaves(payload ?? record),
    })
  }

  // 工作区状态的完整快照。它的 `state.agents_md.text` 是整份 AGENTS.md，
  // 所以这里**只带目录与存在性**，不把正文复制进派生层——正文本来就在源文件里，
  // 复制一遍只会让 normalized.jsonl 无谓地膨胀。
  if (channel === 'world_state') {
    const state = isObject(payload?.state) ? payload.state : {}
    const agentsMd = isObject(state.agents_md) ? state.agents_md : {}
    return defined({
      line,
      kind: 'context',
      ...name,
      full: payload?.full === true ? true : undefined,
      agentsMdDirectory: typeof agentsMd.directory === 'string' ? agentsMd.directory : undefined,
      agentsMdBytes: typeof agentsMd.text === 'string' ? Buffer.byteLength(agentsMd.text, 'utf8') : undefined,
    })
  }

  if (channel === 'compacted') {
    const history = payload && Array.isArray(payload.replacement_history) ? payload.replacement_history : []
    return {
      line,
      kind: 'compaction',
      ...name,
      windowNumber: typeof payload?.window_number === 'number' ? payload.window_number : undefined,
      replacedCount: history.length,
      // payload.message 实测恒为空字符串，不当作内容带出。
    }
  }

  if (channel === 'token_usage_record') {
    return { line, kind: 'telemetry', ...name, source: channel, metrics: numericLeaves(payload ?? record) }
  }

  if (channel === 'response_item' || channel === 'event_msg') {
    switch (payloadType) {
      case 'message':
      case 'user_message':
      case 'agent_message': {
        // agent_message 两版形态：早期 `message` 字符串，较新 `content` 块数组。
        const text = textOf(payload?.content) || textOf(payload?.message)
        const role = payloadType === 'user_message' ? 'user'
          : payloadType === 'agent_message' ? 'assistant'
            : (typeof payload?.role === 'string' ? payload.role : 'unknown')
        return { line, kind: 'message', ...name, role, text }
      }
      case 'reasoning':
      case 'agent_reasoning': {
        // content 实测恒为 null；可读文本只在 summary（块数组）。密文只记存在性。
        const text = textOf(payload?.summary) || textOf(payload?.content) || textOf(payload?.text)
        return {
          line,
          kind: 'reasoning',
          ...name,
          text,
          encrypted: typeof payload?.encrypted_content === 'string' && payload.encrypted_content.length > 0,
        }
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'tool_search_call':
        return {
          line,
          kind: 'tool-call',
          ...name,
          callId: typeof payload?.call_id === 'string' ? payload.call_id : '',
          name: typeof payload?.name === 'string' ? payload.name : 'unknown',
          // custom_tool_call 用 `input`，function_call / tool_search_call 用 `arguments`。
          arguments: typeof payload?.arguments === 'string' ? payload.arguments
            : (typeof payload?.input === 'string' ? payload.input : ''),
        }
      case 'web_search_call':
        // 注意：这个记录用 `id`，与它配对的 web_search_end 用 `call_id`。
        return {
          line,
          kind: 'tool-call',
          ...name,
          callId: typeof payload?.id === 'string' ? payload.id : '',
          name: 'web_search',
          arguments: JSON.stringify(payload?.action ?? null),
        }
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'web_search_end':
        return {
          line,
          kind: 'tool-output',
          ...name,
          callId: typeof payload?.call_id === 'string' ? payload.call_id : '',
          output: typeof payload?.output === 'string' ? payload.output
            : (payloadType === 'web_search_end' ? JSON.stringify(payload?.results ?? payload?.query ?? null) : ''),
        }
      case 'tool_search_output':
        return {
          line,
          kind: 'tool-output',
          ...name,
          callId: typeof payload?.call_id === 'string' ? payload.call_id : '',
          output: JSON.stringify(payload?.tools ?? null),
        }
      case 'patch_apply_end':
        return {
          line,
          kind: 'tool-output',
          ...name,
          callId: typeof payload?.call_id === 'string' ? payload.call_id : '',
          output: [payload?.stdout, payload?.stderr].filter((v) => typeof v === 'string' && v).join('\n'),
        }
      case 'token_count':
        return { line, kind: 'telemetry', ...name, source: 'token_count', metrics: numericLeaves(payload?.info ?? payload) }
      case 'task_started':
        return { line, kind: 'boundary', ...name, phase: 'turn-start' }
      case 'task_complete':
        return { line, kind: 'boundary', ...name, phase: 'turn-end' }
      case 'turn_aborted':
        return { line, kind: 'boundary', ...name, phase: 'turn-aborted' }
      case 'item_completed':
        return { line, kind: 'boundary', ...name, phase: 'step-end' }
      case 'context_compacted':
        return { line, kind: 'compaction', ...name }
      default:
        break
    }
  }

  // 认不出的记录带上原始载荷——归档不静默丢东西，未知必须看得见。
  return { line, kind: 'unknown', channel, payloadType, raw: record }
}

/**
 * 流式分类一个 rollout，逐条产出 IR 条目。
 *
 * 行级流式：最大单文件实测 206 MB，不允许整体读入。
 * @param {string} sourcePath - rollout 路径。
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {AsyncGenerator<Record<string, unknown>>}
 */
export async function* classifyRollout(sourcePath, options = {}) {
  const reader = createInterface({
    input: createReadStream(sourcePath, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  })
  let line = 0
  try {
    for await (const text of reader) {
      line += 1
      if (options.signal?.aborted) throw new Error('aborted')
      if (text.length === 0) continue
      let record
      try {
        record = JSON.parse(text)
      } catch (error) {
        yield { line, kind: 'unknown', reason: 'unparseable', detail: String(error?.message ?? error) }
        continue
      }
      yield classifyRecord(record, line)
    }
  } finally {
    reader.close()
  }
}

/**
 * 从 rollout 展开摘要，供 `meta.json` 使用。
 *
 * 只保留分类期的少量标量，不缓存条目——这是给 meta.json 的，不是给 normalized.jsonl 的。
 * @param {string} sourcePath - rollout 路径。
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function summarizeRollout(sourcePath, options = {}) {
  /** @type {Record<string, number>} */
  const counts = {}
  /** @type {Record<string, unknown>} */
  const meta = {}
  let total = 0
  for await (const entry of classifyRollout(sourcePath, options)) {
    const kind = String(entry.kind)
    counts[kind] = (counts[kind] ?? 0) + 1
    total += 1
    if (entry.kind === 'session-meta' && meta.id === undefined) {
      // 只取元数据字段；`line` / `kind` 是分类器的簿记，不属于会话元数据。
      for (const [key, value] of Object.entries(entry)) {
        if (key === 'line' || key === 'kind') continue
        if (value !== undefined) meta[key] = value
      }
    }
  }
  return { ...meta, lineCount: total, counts }
}

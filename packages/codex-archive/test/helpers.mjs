// helpers.mjs — 合成语料构造器。
//
// 全部字段形态都在真实语料上核验过（5538 个 rollout 随机抽样）。**不要凭记忆加字段**——
// 本仓库此前有过把猜测写进 fixture 再当成真实格式的错误，加任何字段前先拿真实样本核验。
//
// 真实语料只用于核验形态，样本本身绝不入库。

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const j = (o) => JSON.stringify(o)

/**
 * 一条覆盖全部已核验记录类型的 rollout 内容。
 *
 * 每种形态的来源：
 *   session_meta     id / timestamp / cwd / originator / cli_version / source / model_provider
 *   turn_context     cwd / model / approval_policy
 *   message          content(块数组) / role
 *   reasoning        content(恒 null) / summary(块数组) / encrypted_content
 *   function_call    call_id / name / arguments
 *   custom_tool_call call_id / name / input      （注意是 input，不是 arguments）
 *   web_search_call  id                          （注意是 id，不是 call_id）
 *   web_search_end   call_id / query / results
 *   agent_message    两种形态并存：早期 message(字符串) / 较新 content(块数组)
 *   token_count      info / rate_limits
 *   compacted        message(恒空) / replacement_history(数组) / window_number
 *
 * 下面四种是把 50 个真实会话跑过一遍后补的——它们在那批样本里分别出现 188、323、60、37 次，
 * 原先全被归入 unknown。字段名取自真实记录。
 *   world_state      full / state.agents_md.{directory,text}
 *   thread_settings_applied   thread_id / thread_settings.{cwd,model,approval_policy,reasoning_effort}
 *   thread_goal_updated       goal.{threadId,objective,status,tokensUsed,createdAt,updatedAt}
 *   inter_agent_communication_metadata   trigger_turn（顶层类型，无 payload.type）
 */
export function rolloutLines(id = '019f0000-0000-7000-8000-000000000001') {
  return [
    j({ timestamp: '2026-01-02T03:04:05.000Z', type: 'session_meta', payload: {
      id, timestamp: '2026-01-02T03:04:05.000Z', cwd: '/demo/proj',
      originator: 'codex_cli_rs', cli_version: '0.0.0-fixture', source: 'cli', model_provider: 'openai' } }),
    j({ timestamp: '2026-01-02T03:04:06.000Z', type: 'turn_context', payload: {
      cwd: '/demo/proj', model: 'gpt-5', approval_policy: 'never' } }),
    j({ timestamp: '2026-01-02T03:04:06.050Z', type: 'world_state', payload: {
      full: true, state: { agents_md: { directory: '/demo/proj', text: '# Demo\nBest effort.\n' } } } }),
    j({ timestamp: '2026-01-02T03:04:06.070Z', type: 'event_msg', payload: {
      type: 'thread_settings_applied', thread_id: 'th1', thread_settings: {
        model: 'gpt-5', model_provider_id: 'openai', approval_policy: 'never',
        cwd: '/demo/proj', reasoning_effort: 'medium' } } }),
    j({ timestamp: '2026-01-02T03:04:06.080Z', type: 'inter_agent_communication_metadata', payload: {
      trigger_turn: false } }),
    j({ timestamp: '2026-01-02T03:04:06.090Z', type: 'event_msg', payload: {
      type: 'thread_goal_updated', threadId: 'th1', goal: {
        threadId: 'th1', objective: 'Archive the history.', status: 'active',
        tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } } }),
    j({ timestamp: '2026-01-02T03:04:06.100Z', type: 'event_msg', payload: {
      type: 'task_started', turn_id: 't1', started_at: 1, model_context_window: 400000 } }),
    j({ timestamp: '2026-01-02T03:04:07.000Z', type: 'response_item', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'List the files.' }] } }),
    j({ timestamp: '2026-01-02T03:04:07.010Z', type: 'event_msg', payload: {
      type: 'user_message', message: 'List the files.', images: [], local_images: [] } }),
    j({ timestamp: '2026-01-02T03:04:08.000Z', type: 'response_item', payload: {
      type: 'reasoning', content: null, summary: [{ type: 'summary_text', text: 'Inventory requested.' }],
      encrypted_content: 'b3BhcXVlLWZpeHR1cmUtY2lwaGVydGV4dA==' } }),
    j({ timestamp: '2026-01-02T03:04:09.000Z', type: 'response_item', payload: {
      type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'call_1' } }),
    j({ timestamp: '2026-01-02T03:04:09.200Z', type: 'response_item', payload: {
      type: 'custom_tool_call', call_id: 'call_2', name: 'apply_patch', input: '*** Begin Patch', status: 'completed' } }),
    j({ timestamp: '2026-01-02T03:04:09.300Z', type: 'response_item', payload: {
      type: 'custom_tool_call_output', call_id: 'call_2', output: 'Done!' } }),
    j({ timestamp: '2026-01-02T03:04:09.400Z', type: 'response_item', payload: {
      type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'x' } } }),
    j({ timestamp: '2026-01-02T03:04:09.500Z', type: 'event_msg', payload: {
      type: 'web_search_end', call_id: 'ws_1', query: 'x', results: [{ title: 't', url: 'https://example.invalid/' }] } }),
    j({ timestamp: '2026-01-02T03:04:09.600Z', type: 'response_item', payload: {
      type: 'function_call_output', call_id: 'call_1', output: 'README.md' } }),
    j({ timestamp: '2026-01-02T03:04:10.000Z', type: 'event_msg', payload: {
      type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 2 } }, rate_limits: null } }),
    j({ timestamp: '2026-01-02T03:04:11.000Z', type: 'response_item', payload: {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'One README.' }] } }),
    // 较新形态：content + author + recipient
    j({ timestamp: '2026-01-02T03:04:11.010Z', type: 'event_msg', payload: {
      type: 'agent_message', content: [{ type: 'output_text', text: 'One README.' }],
      author: 'assistant', recipient: 'user', id: 'am1' } }),
    // 早期形态：message 字符串
    j({ timestamp: '2026-01-02T03:04:11.020Z', type: 'event_msg', payload: {
      type: 'agent_message', message: 'One README (legacy shape).' } }),
    j({ timestamp: '2026-01-02T03:04:12.000Z', type: 'event_msg', payload: {
      type: 'item_completed', item: { type: 'message' }, thread_id: 'th1', turn_id: 't1', completed_at_ms: 12000 } }),
    j({ timestamp: '2026-01-02T03:04:12.100Z', type: 'event_msg', payload: {
      type: 'task_complete', turn_id: 't1', completed_at: 12000, duration_ms: 6000 } }),
    j({ timestamp: '2026-01-02T03:04:27.000Z', type: 'compacted', payload: {
      message: '', window_number: 1,
      replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'earlier' }] }] } }),
    // 夹具里**故意不放**认不出的类型。留着一条会让"每种记录都有归属"那条断言失去意义，
    // 而 unknown 的行为由 classify.test.mjs 里的专门用例和畸形行用例各自覆盖。
  ]
}

/**
 * 造一个合成的 Codex home。
 * @param {{ rollouts?: number, withCredentials?: boolean, extra?: Record<string, string> }} [options]
 * @returns {Promise<{ home: string, cleanup: () => Promise<void> }>}
 */
export async function makeCodexHome(options = {}) {
  const rollouts = options.rollouts ?? 2
  const home = await mkdtemp(join(tmpdir(), 'codex-archive-test-'))

  const dated = join(home, 'sessions', '2026', '01', '02')
  await mkdir(dated, { recursive: true })
  await mkdir(join(home, 'archived_sessions'), { recursive: true })
  await mkdir(join(home, 'skills', 'demo'), { recursive: true })
  await mkdir(join(home, 'rules'), { recursive: true })
  await mkdir(join(home, 'prompts'), { recursive: true })
  await mkdir(join(home, 'agents'), { recursive: true })

  for (let i = 0; i < rollouts; i += 1) {
    const suffix = String(i + 1).padStart(12, '0')
    const id = `019f0000-0000-7000-8000-${suffix}`
    const body = `${rolloutLines(id).join('\n')}\n`
    // 交替放进日期分区与扁平归档，两个根都要覆盖。
    const target = i % 2 === 0
      ? join(dated, `rollout-2026-01-02T03-04-05-${id}.jsonl`)
      : join(home, 'archived_sessions', `rollout-2026-01-02T03-04-05-${id}.jsonl`)
    await writeFile(target, body, 'utf8')
  }

  await writeFile(join(home, 'AGENTS.md'), 'Best effort.\n', 'utf8')
  await writeFile(join(home, 'hooks.json'), '{"hooks":{}}\n', 'utf8')
  await writeFile(join(home, 'rules', 'default.rules'), 'prefix_rule(pattern=["git","pull"], decision="allow")\n', 'utf8')
  await writeFile(join(home, 'prompts', 'demo.md'), '---\ndescription: demo\n---\nbody\n', 'utf8')
  await writeFile(join(home, 'agents', 'demo.toml'), 'name = "demo"\n', 'utf8')
  await writeFile(join(home, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\n---\nbody\n', 'utf8')

  const config = options.withCredentials === false
    ? '[mcp_servers.x]\nurl = "https://example.invalid/mcp"\n'
    : '[mcp_servers.x]\nurl = "https://example.invalid/mcp"\n'
      + 'http_headers = { Authorization = "Bearer abcdefghijklmnopqrstuvwxyz012345" }\n'
  await writeFile(join(home, 'config.toml'), config, 'utf8')

  for (const [rel, body] of Object.entries(options.extra ?? {})) {
    const path = join(home, rel)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, body, 'utf8')
  }

  return { home, cleanup: () => rm(home, { recursive: true, force: true }) }
}

/** 造一个临时输出目录。 */
export async function makeOutDir() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-archive-out-'))
  return { outDir: dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** 源树的 (相对路径 -> 大小:修改时间) 快照，用于只读断言。 */
export async function snapshotTree(root) {
  const { readdir, stat } = await import('node:fs/promises')
  const { relative, sep } = await import('node:path')
  const out = {}
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { stack.push(path); continue }
      const info = await stat(path)
      out[relative(root, path).split(sep).join('/')] = `${info.size}:${info.mtimeMs}`
    }
  }
  return out
}

// classify.test.mjs — 分类器。
//
// 分类器是派生层，允许有损，但不允许**静默**有损。所以这里既测认得出的，
// 也测认不出的（必须进 unknown 并带原始载荷，而不是被丢掉）。
//
// fixture 里每个字段的形态都在真实语料上核验过（见 helpers.mjs 的注释）。
// 两处版本差异是重点：agent_message 的两种形态，以及 web_search 的 id/call_id 错位。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { classifyRecord, classifyRollout, summarizeRollout, textOf, ENTRY_KINDS } from '../src/classify.mjs'
import { rolloutLines } from './helpers.mjs'

const j = (o) => JSON.stringify(o)

test('每种已核验的记录类型都有归属，且 kind 在规范列举的集合内', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ca-classify-'))
  const path = join(dir, 'rollout.jsonl')
  try {
    await writeFile(path, `${rolloutLines().join('\n')}\n`, 'utf8')
    const kinds = new Set()
    for await (const entry of classifyRollout(path)) {
      assert.ok(ENTRY_KINDS.includes(entry.kind), `${entry.kind} 不在规范列举的类别里`)
      kinds.add(entry.kind)
    }
    for (const expected of ['session-meta', 'context', 'goal', 'message', 'tool-call', 'tool-output', 'reasoning', 'boundary', 'telemetry', 'compaction']) {
      assert.ok(kinds.has(expected), `缺少 ${expected}`)
    }
    // `unknown` 不在夹具里。它的存在由专门的用例保证——夹具里留一条认不出的记录
    // 会让上面这条"每种类型都有归属"的断言失去意义。
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('agent_message 的两种版本形态都能读出文本', () => {
  // 较新形态：content 块数组 + author/recipient
  const modern = classifyRecord({ type: 'event_msg', payload: {
    type: 'agent_message', content: [{ type: 'output_text', text: 'modern' }], author: 'assistant', recipient: 'user' } }, 1)
  assert.equal(modern.kind, 'message')
  assert.equal(modern.role, 'assistant')
  assert.equal(modern.text, 'modern')

  // 早期形态：message 字符串
  const legacy = classifyRecord({ type: 'event_msg', payload: { type: 'agent_message', message: 'legacy' } }, 2)
  assert.equal(legacy.kind, 'message')
  assert.equal(legacy.role, 'assistant')
  assert.equal(legacy.text, 'legacy')
})

test('web_search 用 id 与 call_id 两侧各自读对', () => {
  const call = classifyRecord({ type: 'response_item', payload: { type: 'web_search_call', id: 'ws_1', action: { query: 'x' } } }, 1)
  const end = classifyRecord({ type: 'event_msg', payload: { type: 'web_search_end', call_id: 'ws_1', results: [] } }, 2)
  assert.equal(call.kind, 'tool-call')
  assert.equal(call.callId, 'ws_1', 'web_search_call 用 id')
  assert.equal(end.kind, 'tool-output')
  assert.equal(end.callId, 'ws_1', 'web_search_end 用 call_id，两者必须能配上')
})

test('custom_tool_call 读 input 而非 arguments', () => {
  const entry = classifyRecord({ type: 'response_item', payload: {
    type: 'custom_tool_call', call_id: 'c1', name: 'apply_patch', input: '*** Begin Patch' } }, 1)
  assert.equal(entry.kind, 'tool-call')
  assert.equal(entry.arguments, '*** Begin Patch')
})

test('reasoning：content 为 null 时仍从 summary 取到文本，密文只记存在性', () => {
  const entry = classifyRecord({ type: 'response_item', payload: {
    type: 'reasoning', content: null,
    summary: [{ type: 'summary_text', text: 'readable' }],
    encrypted_content: 'b3BhcXVl' } }, 1)
  assert.equal(entry.kind, 'reasoning')
  assert.equal(entry.text, 'readable')
  assert.equal(entry.encrypted, true)
  assert.ok(!JSON.stringify(entry).includes('b3BhcXVl'), '密文本身绝不进入 IR')
})

test('compacted：replacement_history 是数组，message 为空不计入内容', () => {
  const entry = classifyRecord({ type: 'compacted', payload: {
    message: '', window_number: 2,
    replacement_history: [{ type: 'message' }, { type: 'message' }, { type: 'message' }] } }, 7)
  assert.equal(entry.kind, 'compaction')
  assert.equal(entry.replacedCount, 3)
  assert.equal(entry.windowNumber, 2)
})

test('真实语料里那四种未建模类型现在都有归属，且每条记录都带自己的记录名', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ca-classify-'))
  const path = join(dir, 'rollout.jsonl')
  try {
    await writeFile(path, `${rolloutLines().join('\n')}\n`, 'utf8')
    const unknowns = []
    /** 按 `channel` 或 `payloadType` 索引；同一个键可能有多条，所以存数组。 */
    const byType = new Map()
    for await (const entry of classifyRollout(path)) {
      if (entry.kind === 'unknown') unknowns.push(entry.channel + '/' + (entry.payloadType ?? ''))
      const key = entry.payloadType ?? entry.channel
      if (!byType.has(key)) byType.set(key, [])
      byType.get(key).push(entry)
    }
    /** 取该类型的唯一一条；多于一条说明夹具里有意放了两种形态，调用方要显式选。 */
    const one = (key) => {
      const list = byType.get(key)
      assert.equal(list?.length, 1, `${key} 应恰好有一条`)
      return list[0]
    }

    // 夹具里已经不含任何未建模类型。这条断言把"新类型悄悄退回 unknown"变成一次失败，
    // 而不是一次静默退化——补建模之前，这里原本有四种。
    assert.deepEqual(unknowns, [], '夹具里的每种记录都该有归属')

    // thread_settings_applied 带的正是下游最需要的三个字段。
    const settings = one('thread_settings_applied')
    assert.equal(settings.kind, 'context')
    assert.equal(settings.cwd, '/demo/proj')
    assert.equal(settings.model, 'gpt-5')
    assert.equal(settings.approvalPolicy, 'never')
    assert.equal(settings.reasoningEffort, 'medium')

    // 目标记录带出用户自己写的那句话。
    const goal = one('thread_goal_updated')
    assert.equal(goal.kind, 'goal')
    assert.equal(goal.objective, 'Archive the history.')
    assert.equal(goal.status, 'active')
    assert.equal(goal.threadId, 'th1')

    // 顶层元数据类型没有 payload.type，仍然要有归属。
    const interAgent = one('inter_agent_communication_metadata')
    assert.equal(interAgent.kind, 'telemetry')

    // 每条条目都要带自己的记录名。只带 `kind` 的话，`agent_message` 与 `token_count`
    // 都来自 `event_msg`，读者只能从字段形状反推原本是什么——版本一变就失效的那种推断。
    for (const [, list] of byType) {
      for (const entry of list) {
        assert.equal(typeof entry.channel, 'string', `第 ${entry.line} 行缺少 channel`)
      }
    }
    // 逐条核对转发：凡是源记录里有 `payload.type` 的，条目上必须一模一样地出现。
    const records = rolloutLines().map((l) => JSON.parse(l))
    const entries = []
    for await (const entry of classifyRollout(path)) entries.push(entry)
    assert.equal(entries.length, records.length, '每行都要产出一条，不得跳过')
    for (let i = 0; i < records.length; i += 1) {
      const from = records[i].payload?.type
      if (typeof from === 'string') {
        assert.equal(entries[i].payloadType, from, `第 ${i + 1} 行的记录名必须原样带出`)
      } else {
        assert.ok(!('payloadType' in entries[i]), `第 ${i + 1} 行本就没有 payload.type，不该凭空造一个`)
      }
      assert.equal(entries[i].channel, records[i].type)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('未建模的顶层类型进 unknown 并带原始载荷', () => {
  // 用一个真实语料里没见过、`ENTRY_KINDS` 里也没有的类型。这条测试的意义在于：
  // 将来真出现新类型时，它必须**看得见**地带出原始载荷，而不是被静默丢掉。
  const record = { type: 'some_future_channel', payload: { opaque: true } }
  const entry = classifyRecord(record, 9)
  assert.equal(entry.kind, 'unknown')
  assert.equal(entry.channel, 'some_future_channel')
  assert.deepEqual(entry.raw, record, '原始载荷必须带出——归档不静默丢东西')
})

test('世界状态快照是有归属的 context，不是 unknown', () => {
  // 这一条先前的判断是反的：`world_state` 曾被当成"未建模的顶层类型"。
  // 跑过 50 个真实会话后它出现 188 次，且带的是会话所在的目录——下游需要它。
  const entry = classifyRecord({ type: 'world_state', payload: {
    full: true, state: { agents_md: { directory: '/demo/proj', text: '# Demo\n' } } } }, 9)
  assert.equal(entry.kind, 'context')
  assert.equal(entry.full, true)
  assert.equal(entry.agentsMdDirectory, '/demo/proj')
  assert.equal(entry.agentsMdBytes, Buffer.byteLength('# Demo\n', 'utf8'))
  assert.ok(!JSON.stringify(entry).includes('Best effort'), '正文不进派生层')
  assert.equal(entry.raw, undefined, '已建模的记录不带原始载荷')
})

test('未建模的 payload.type 同样进 unknown 并保留类型名', () => {
  const entry = classifyRecord({ type: 'response_item', payload: { type: 'ghost_snapshot', ghost_commit: 'abc' } }, 3)
  assert.equal(entry.kind, 'unknown')
  assert.equal(entry.payloadType, 'ghost_snapshot')
})

test('畸形行被记为 unknown 而不是中断整个文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ca-classify-'))
  const path = join(dir, 'rollout.jsonl')
  try {
    await writeFile(path, [
      j({ type: 'session_meta', payload: { id: 'x' } }),
      '{ this is not json }',
      j({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'after' }] } }),
    ].join('\n') + '\n', 'utf8')

    const entries = []
    for await (const entry of classifyRollout(path)) entries.push(entry)

    assert.equal(entries.length, 3)
    assert.equal(entries[1].kind, 'unknown')
    assert.equal(entries[1].reason, 'unparseable')
    assert.equal(entries[2].text, 'after', '坏行之后的记录仍要读出')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('summarizeRollout 带出元数据与计数，且不含分类器簿记字段', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ca-classify-'))
  const path = join(dir, 'rollout.jsonl')
  try {
    await writeFile(path, `${rolloutLines('019f0000-0000-7000-8000-000000000009').join('\n')}\n`, 'utf8')
    const meta = await summarizeRollout(path)
    assert.equal(meta.id, '019f0000-0000-7000-8000-000000000009')
    assert.equal(meta.cwd, '/demo/proj')
    assert.equal(meta.cliVersion, '0.0.0-fixture')
    assert.ok(meta.counts.message >= 3)
    assert.equal(meta.lineCount, rolloutLines().length)
    assert.ok(!('line' in meta))
    assert.ok(!('kind' in meta))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('textOf 处理字符串、块数组与 null 三种形态', () => {
  assert.equal(textOf('plain'), 'plain')
  assert.equal(textOf([{ type: 'input_text', text: 'a' }, { type: 'output_text', text: 'b' }]), 'a\nb')
  assert.equal(textOf([{ type: 'summary_text', text: 's' }]), 's')
  assert.equal(textOf([{ type: 'input_image', image_url: 'x' }]), '[image]')
  assert.equal(textOf(null), '')
  assert.equal(textOf(undefined), '')
  assert.equal(textOf(42), '')
})
